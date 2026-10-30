import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { describeWireBody } from "../src/stage/cache-diagnostics.mjs"

// Compare diagnostic fingerprints against bodies actually received by the
// loopback Provider. Scripted usage is not real cache/billing evidence.
export async function assertCacheDiagnostics(openCode, requests) {
  const file = path.join(openCode, "bugfix-adaptive-cache.jsonl")
  const events = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  const wire = events.filter(event => event.layer === "provider-fetch-input")
  assert.equal(wire.length, requests.length, "every transport request must be observed, even without a Carrier")
  const orders = new Map()
  for (let index = 0; index < wire.length; index++) {
    const event = wire[index], expected = describeWireBody(requests[index].body)
    assert.equal(event.system.sha256, expected.system.sha256)
    assert.equal(event.system.serializedBytes, expected.system.serializedBytes)
    assert.equal(event.tools.sha256, expected.tools.sha256)
    assert.equal(event.messages.sha256, expected.messages.sha256)
    assert.equal(event.messages.count, expected.messages.count)
    assert.equal(event.cacheSettings.sha256, expected.cacheSettings.sha256)
    assert.equal(event.downstreamCustomFetch, false)
    if (event.toolOrder) orders.set(event.requestID, event.toolOrder)
    assert.deepEqual(orders.get(event.toolOrderFromRequestID), expected.toolOrder)
  }
  assert.ok(events.some(event => event.layer === "system-transform-hook" && event.tools.available === false))
  const runtime = events.filter(event => event.type === "bugfix-adaptive-runtime-agent")
  assert.ok(runtime.length > 0 && runtime.every(event => event.runtimeAgent && event.runtimeMessage?.messageID),
    "real chat.params must expose Agent name and unwrapped User Message ID")
  assert.doesNotMatch(JSON.stringify(events), /ISSUE_SOURCE_CANARY|LARGE_SOURCE_0|CANARY_STAGE_|API_KEY|beforeMessages|afterMessages/)
  return {
    hookRecords: events.filter(event => event.layer === "system-transform-hook").length,
    projectionDecisions: events.filter(event => event.type === "bugfix-adaptive-projection-decision").length,
    runtimeAgentRecords: events.filter(event => event.type === "bugfix-adaptive-runtime-agent").length,
    stageDecisions: events.filter(event => event.type === "bugfix-adaptive-stage-decision").length,
    unattributedRequests: wire.filter(event => event.observedSessionID === null).length,
    providerFetchRecords: wire.length,
    summaryRecords: wire.filter(event => event.requestKind === "native-compaction").length,
    fingerprintsMatchReceivedBodies: true, bytes: (await fs.stat(file)).size,
  }
}
