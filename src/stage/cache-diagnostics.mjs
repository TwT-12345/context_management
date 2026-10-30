import { createHash, randomUUID } from "node:crypto"

// Observation only: never change request bodies, headers, responses or Task State.
// Keep fingerprints in memory, not another copy of the conversation on disk.
const MAX_SESSIONS = 128
const MARKER = /<bugfix-adaptive-(context|compaction)\b[^>]*>[\s\S]*?<\/bugfix-adaptive-\1>/gu

export function fingerprint(value) {
  const json = JSON.stringify(value ?? null)
  return {
    sha256: createHash("sha256").update(json).digest("hex"),
    serializedCharacters: json.length,
    serializedBytes: Buffer.byteLength(json, "utf8"),
  }
}

function describeMessage(value, messageID) {
  return { ...fingerprint(value), role: value.role ?? "unknown", ...(messageID ? { messageID } : {}) }
}

export function compareMessages(previous, current) {
  if (!previous || !current) return { kind: "unavailable", firstChangedIndex: null }
  let index = 0
  while (index < previous.length && index < current.length && previous[index].sha256 === current[index].sha256) index++
  const kind = index < previous.length && index < current.length ? "replaced"
    : index < previous.length ? "removed" : index < current.length ? "appended" : "unchanged"
  return {
    kind, firstChangedIndex: kind === "unchanged" ? null : index,
    unchangedPrefixMessages: index, previousCount: previous.length, currentCount: current.length,
    previous: previous[index] ?? null, current: current[index] ?? null,
  }
}

function nativeMessages(messages) {
  return messages.map(message => describeMessage({
    role: message.info?.role,
    parts: (message.parts ?? []).filter(part => ["text", "reasoning", "tool", "file", "compaction"].includes(part.type))
      .map(part => {
        // Native IDs/timestamps/diff metadata aren't the model's prompt.
        if (part.type === "text" || part.type === "reasoning") return {
          type: part.type, text: part.text, ignored: part.ignored, metadata: part.metadata,
        }
        if (part.type === "tool") return {
          type: part.type, tool: part.tool, callID: part.callID, metadata: part.metadata,
          status: part.state?.status, input: part.state?.input,
          output: part.state?.output, error: part.state?.error,
          compacted: Boolean(part.state?.time?.compacted), attachments: part.state?.attachments,
        }
        return { type: part.type, mime: part.mime, url: part.url, filename: part.filename }
      }),
  }, message.info?.id))
}

function visitStrings(value, callback) {
  if (typeof value === "string") callback(value)
  else if (Array.isArray(value)) for (const item of value) visitStrings(item, callback)
  else if (value && typeof value === "object") for (const item of Object.values(value)) visitStrings(item, callback)
}

function markerHashes(value) {
  const result = new Set()
  visitStrings(value, text => {
    for (const match of text.matchAll(MARKER)) result.add(fingerprint(match[0]).sha256)
  })
  return result
}

function userDescriptor(message) {
  if (!message) return null
  // Messages Transform wraps info; chat.params exposes the User info directly.
  const info = message.info ?? message
  return {
    messageID: info.id ?? null, agent: info.agent ?? null,
    synthetic: Array.isArray(message.parts) ? message.parts.some(part => part.synthetic === true) : null,
    compaction: Array.isArray(message.parts) ? message.parts.some(part => part.type === "compaction") : null,
  }
}

function stageSnapshot(session) {
  return {
    currentStageID: session?.currentStageID ?? null,
    currentStageRunID: session?.currentStageRunID ?? null,
    boundary: session?.stageBoundary ? { ...session.stageBoundary } : null,
  }
}

function changes(prior, current) {
  return {
    systemChanged: prior ? prior.system.sha256 !== current.system.sha256 : null,
    toolsChanged: prior && current.tools.available !== false ? prior.tools.sha256 !== current.tools.sha256 : null,
    cacheSettingsChanged: prior && current.cacheSettings ? prior.cacheSettings?.sha256 !== current.cacheSettings.sha256 : null,
    messages: compareMessages(prior?.messageFingerprints, current.messageFingerprints),
  }
}

function boundedSet(map, key, value, limit = MAX_SESSIONS) {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
}

export function describeWireBody(body) {
  const format = Array.isArray(body.messages) ? "messages"
    : Array.isArray(body.input) || typeof body.input === "string" ? "responses"
    : Array.isArray(body.contents) ? "contents" : null
  if (!format) return null
  const messages = format === "messages" ? body.messages : format === "contents" ? body.contents
    : Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }]
  const system = {
    system: body.system, instructions: body.instructions, systemInstruction: body.systemInstruction,
    // Include their positions: some modified clients inject instructions mid-list.
    messageInstructions: messages.flatMap((message, index) =>
      ["system", "developer"].includes(message.role) ? [{ index, message }] : []),
  }
  const tools = body.tools ?? body.toolConfig?.tools ?? []
  const list = Array.isArray(tools) ? tools : Object.values(tools)
  const order = list.flatMap(tool => Array.isArray(tool.functionDeclarations)
    ? tool.functionDeclarations.map(item => item.name ?? "<unnamed>")
    : [tool.function?.name ?? tool.toolSpec?.name ?? tool.name ?? tool.type ?? "<unnamed>"])
  return {
    format, system: fingerprint(system), tools: { ...fingerprint(tools), count: order.length },
    toolOrder: order, messages: { ...fingerprint(messages), count: messages.length },
    messageFingerprints: messages.map(message => describeMessage(message)),
    // Configuration can affect caching independently of prompt text. Hash only;
    // never dump provider options, headers, credentials or arbitrary request fields.
    cacheSettings: fingerprint({
      cache_control: body.cache_control, prompt_cache_key: body.prompt_cache_key,
      prompt_cache_retention: body.prompt_cache_retention, cachedContent: body.cachedContent,
      tool_choice: body.tool_choice, thinking: body.thinking, reasoning: body.reasoning,
      reasoning_effort: body.reasoning_effort, output_config: body.output_config,
    }),
  }
}

export function createCacheDiagnostics({ append, enabled = true }) {
  const sessions = new Map()
  const previous = new Map()
  const transportPrevious = new Map()
  const transports = new Set()
  const wrapped = new WeakSet()
  let transportSequence = 0
  let warned = false
  const warn = () => {
    if (!warned) console.warn("[bugfix-adaptive-cache] Diagnostic recording failed; business execution is unchanged.")
    warned = true
  }
  const safely = async action => { try { return await action() } catch { warn() } }
  const save = event => append({ type: "bugfix-adaptive-cache-diagnostic", schemaVersion: 2, time: new Date().toISOString(), ...event })

  function forget(sessionID) {
    sessions.delete(sessionID)
    for (const key of previous.keys()) if (JSON.parse(key)[0] === sessionID) previous.delete(key)
  }

  function register(session, kind, texts, messages, extra = {}) {
    if (!enabled) return
    const meta = {
      observedSessionID: session.sessionID, ...stageSnapshot(session), requestKind: kind,
      hashes: markerHashes(texts), messages: messages ? nativeMessages(messages) : null,
      hookRequestID: null, projectionID: null, projectionDecision: "unobserved",
      systemSeen: false, runtimeSeen: false, ...extra,
    }
    sessions.delete(session.sessionID)
    sessions.set(session.sessionID, meta)
    while (sessions.size > MAX_SESSIONS) {
      const id = sessions.keys().next().value
      forget(id)
    }
  }

  async function record(meta, layer, providerID, modelID, description, transport = null) {
    const requestID = randomUUID()
    const key = JSON.stringify([meta.observedSessionID, layer, providerID, modelID])
    const prior = meta.observedSessionID ? previous.get(key) : null
    const transportPrior = transport ? transportPrevious.get(transport.key) : null
    const orderPrior = transport ? transportPrior : prior
    const { messageFingerprints, toolOrder, ...components } = description
    const orderChanged = toolOrder && JSON.stringify(toolOrder) !== JSON.stringify(orderPrior?.toolOrder)
    const event = {
      requestID, hookRequestID: meta.hookRequestID, observedSessionID: meta.observedSessionID,
      currentStageID: meta.currentStageID, currentStageRunID: meta.currentStageRunID,
      projectionID: meta.projectionID, projectionDecision: meta.projectionDecision,
      runtimeAgent: meta.runtimeAgent ?? null,
      requestKind: meta.requestKind, providerID, modelID, layer,
      finalHttpBodyGuaranteed: false,
      ...(transport ? {
        downstreamCustomFetch: transport.custom, correlation: transport.correlation,
        transportSequence: transport.sequence,
        transportPreviousSequence: transportPrior?.transportSequence ?? null,
        endpointSha256: transport.endpointSha256,
        transportComparisonScope: "provider-model-endpoint-may-cross-sessions",
        transportPreviousRequestID: transportPrior?.requestID ?? null,
        transportChanges: changes(transportPrior, description),
      } : {
        transportObservation: transports.has(providerID) ? "observed-previously" : "not-observed",
      }),
      ...components,
      toolOrder: toolOrder ? orderChanged ? toolOrder : null : null,
      toolOrderFromRequestID: toolOrder ? orderChanged ? requestID : orderPrior.toolOrderFromRequestID : null,
      previousRequestID: prior?.requestID ?? null,
      changes: changes(prior, description),
    }
    await save(event)
    const snapshot = {
      requestID, system: description.system, tools: description.tools, cacheSettings: description.cacheSettings,
      messageFingerprints, toolOrder, toolOrderFromRequestID: event.toolOrderFromRequestID,
      transportSequence: transport?.sequence ?? null,
    }
    if (meta.observedSessionID) boundedSet(previous, key, snapshot, MAX_SESSIONS * 4)
    if (transport) boundedSet(transportPrevious, transport.key, snapshot)
    return requestID
  }

  return {
    forget,
    begin(messages, selectedUser, targetAgent) {
      if (!enabled) return null
      try {
        const users = messages.filter(message => message.info?.role === "user")
        const ids = new Set(messages.map(message => message.info?.sessionID ?? message.parts?.[0]?.sessionID).filter(Boolean))
        const observedSessionID = ids.size === 1 ? [...ids][0] : null
        const prior = sessions.get(observedSessionID)
        const token = {
          projectionID: randomUUID(), observedSessionID, targetAgent,
          selectionRule: "max-message-id-among-agent-bearing-users",
          selectedUser: userDescriptor(selectedUser), latestArrayUser: userDescriptor(users.at(-1)),
          latestIDUser: userDescriptor(users.reduce((a, b) => !a || b.info?.id > a.info?.id ? b : a, null)),
          userCount: users.length, agentBearingUserCount: users.filter(user => typeof user.info?.agent === "string").length,
          before: nativeMessages(messages), beforeFirstMessageID: messages[0]?.info?.id ?? null,
          beforeLastMessageID: messages.at(-1)?.info?.id ?? null,
          lastKnownStage: prior ? { currentStageID: prior.currentStageID, currentStageRunID: prior.currentStageRunID, boundary: prior.boundary } : null,
        }
        // Invalidate stale projection metadata immediately, even if this call exits early.
        if (observedSessionID) register({ sessionID: observedSessionID }, "business", [], null, {
          projectionID: token.projectionID, projectionDecision: "pending",
        })
        return token
      } catch { warn(); return null }
    },
    async decision(token, { decision, reason, session, messages, phase = null, boundaryResolution = null }) {
      if (!enabled || !token) return
      await safely(async () => {
        const after = nativeMessages(messages)
        const stage = session ? stageSnapshot(session) : token.lastKnownStage
        const boundary = stage?.boundary
        const boundaryMessage = messages.find(message => message.parts?.some(part => part.type === "tool" && part.callID === boundary?.enteredAfterToolCallID))
        await save({
          type: "bugfix-adaptive-projection-decision", projectionID: token.projectionID,
          observedSessionID: token.observedSessionID, targetAgent: token.targetAgent,
          selectionRule: token.selectionRule, selectedUser: token.selectedUser,
          latestArrayUser: token.latestArrayUser, latestIDUser: token.latestIDUser,
          userCount: token.userCount, agentBearingUserCount: token.agentBearingUserCount,
          decision, reason, phase, ...stage,
          stateObservation: session ? "read-this-call" : stage ? "last-known-diagnostic-only" : "unavailable",
          projectedStageRunID: decision === "projected" ? session.currentStageRunID : null,
          boundaryResolution, boundaryVisible: Boolean(boundaryMessage),
          boundaryToolStatus: boundaryMessage?.parts?.find(part => part.callID === boundary?.enteredAfterToolCallID)?.state?.status ?? null,
          before: { ...fingerprint(token.before), count: token.before.length, firstMessageID: token.beforeFirstMessageID, lastMessageID: token.beforeLastMessageID },
          after: { ...fingerprint(after), count: after.length, firstMessageID: messages[0]?.info?.id ?? null, lastMessageID: messages.at(-1)?.info?.id ?? null },
          changes: compareMessages(token.before, after),
        })
        if (token.observedSessionID) register(session ?? { sessionID: token.observedSessionID }, "business", messages, messages, {
          projectionID: token.projectionID, projectionDecision: decision, selectedUser: token.selectedUser,
          ...(session ? {} : stage ?? {}),
        })
      })
    },
    async stage(input, session, before, decision, errorCode = null) {
      if (!enabled) return
      await safely(() => save({
        type: "bugfix-adaptive-stage-decision", observedSessionID: input.sessionID,
        callID: input.callID, requestedStageID: input.stageID, decision, errorCode,
        before, after: stageSnapshot(session), statePersisted: decision !== "rejected",
      }))
    },
    stageSnapshot,
    projection(session, messages) {
      try { register(session, "business", messages[0]?.parts?.map(part => part.text), messages) } catch { warn() }
    },
    compaction(session, context) {
      try { register(session, "native-compaction", context, null) } catch { warn() }
    },
    async system(input, output) {
      if (!enabled) return
      await safely(async () => {
        let meta = sessions.get(input.sessionID)
        if (!meta) return
        if (meta.systemSeen) {
          // A system call without a fresh transform must not reuse old message hashes.
          register({ sessionID: input.sessionID }, "unobserved", [], null)
          meta = sessions.get(input.sessionID)
        }
        const providerID = input.model?.providerID ?? "unknown"
        meta.hookRequestID = await record(meta, "system-transform-hook", providerID,
          input.model?.api?.id ?? input.model?.id ?? "unknown", {
            system: fingerprint(output.system), tools: { available: false, reason: "not-exposed-by-hook" },
            messages: meta.messages ? { count: meta.messages.length } : { available: false, reason: meta.requestKind === "native-compaction" ? "native-summary-bypasses-messages-hook" : "no-fresh-messages-transform" },
            messageFingerprints: meta.messages,
          })
        meta.systemSeen = true
      })
    },
    async runtime(input) {
      if (!enabled) return
      await safely(async () => {
        const meta = sessions.get(input.sessionID)
        if (!meta) return
        const fresh = !meta.runtimeSeen
        const agent = typeof input.agent === "string" ? input.agent : input.agent?.name ?? null
        if (fresh) meta.runtimeAgent = agent
        await save({
          type: "bugfix-adaptive-runtime-agent", observedSessionID: input.sessionID,
          projectionID: fresh ? meta.projectionID : null, hookRequestID: fresh ? meta.hookRequestID : null,
          runtimeAgent: agent, runtimeMessage: userDescriptor(input.message),
          selectedUser: fresh ? meta.selectedUser ?? null : null,
          agentMatchesSelection: fresh && meta.selectedUser?.agent && agent ? meta.selectedUser.agent === agent : null,
          providerID: input.model?.providerID ?? null, modelID: input.model?.id ?? null,
          projectionDecision: fresh ? meta.projectionDecision : "unobserved",
        })
        meta.runtimeSeen = true
      })
    },
    configure(config) {
      if (!enabled) return
      for (const [providerID, provider] of Object.entries(config.provider ?? {})) {
        if (!provider || typeof provider !== "object") continue
        const options = provider.options ??= {}
        if (options.fetch !== undefined && typeof options.fetch !== "function") continue
        if (options.fetch && wrapped.has(options.fetch)) continue
        const customFetch = options.fetch
        const delegate = customFetch ?? globalThis.fetch
        if (typeof delegate !== "function") continue
        const observer = async function(input, init) {
          const sequence = ++transportSequence
          await safely(async () => {
            // Never consume a Request/ReadableStream body, clone a response stream,
            // or change the actual fetch arguments to make diagnostics work.
            const raw = init?.body
            if (typeof raw !== "string" && !(raw instanceof Uint8Array)) {
              await save({ layer: "provider-fetch-unavailable", providerID, transportSequence: sequence, reason: "non-buffered-request-body-not-consumed" })
              return
            }
            let body
            try { body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) }
            catch {
              await save({ layer: "provider-fetch-unavailable", providerID, transportSequence: sequence, reason: "request-body-not-json" })
              return
            }
            const description = describeWireBody(body)
            if (!description) {
              await save({ layer: "provider-fetch-unavailable", providerID, transportSequence: sequence, reason: "unsupported-request-format" })
              return
            }
            const hashes = markerHashes([body.messages, body.input, body.contents, body.system, body.instructions, body.systemInstruction])
            const matches = [...sessions.values()].filter(meta => [...meta.hashes].some(hash => hashes.has(hash)))
            const summaries = matches.filter(meta => meta.requestKind === "native-compaction")
            const candidates = summaries.length > 0 ? summaries : matches
            // Missing Carrier is exactly the suspected failure: still log the body
            // fingerprint. Only use an existing OpenCode header for extra attribution.
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            const headerMeta = sessions.get(headers.get("x-opencode-session"))
            const meta = candidates.length === 1 && (!headerMeta || headerMeta === candidates[0])
              ? candidates[0] : candidates.length === 0 ? headerMeta : null
            const correlation = meta ? candidates.length === 1 ? "marker" : "existing-session-header"
              : candidates.length > 0 ? "ambiguous" : "unattributed"
            let endpoint = "unknown"
            try { const url = new URL(input instanceof Request ? input.url : String(input)); endpoint = `${url.origin}${url.pathname}` } catch { /* hash unknown */ }
            const endpointSha256 = fingerprint(endpoint).sha256
            transports.add(providerID)
            await record(meta ?? {
              observedSessionID: null, currentStageID: null, currentStageRunID: null,
              requestKind: "unattributed", projectionID: null, projectionDecision: "unobserved", hookRequestID: null,
            }, "provider-fetch-input", providerID, body.model ?? "unknown", description, {
              custom: Boolean(customFetch), correlation, endpointSha256, sequence,
              key: JSON.stringify([providerID, body.model ?? "unknown", endpointSha256]),
            })
          })
          return Reflect.apply(delegate, this, [input, init])
        }
        wrapped.add(observer)
        options.fetch = observer
      }
    },
  }
}
