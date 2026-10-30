import fs from "node:fs/promises"

// Opt-in only. Credentials stay in this proxy process, never in fixtures/logs.
export async function optionalRealProvider() {
  const file = process.env.BUGFIX_REAL_PROVIDER_CONFIG
  if (!file) return null
  const config = JSON.parse(await fs.readFile(file, "utf8"))
  const model = config.model
  if (typeof model !== "string" || !model.includes("/")) throw new Error("Real smoke needs a configured provider/model")
  const separator = model.indexOf("/")
  const provider = config.provider?.[model.slice(0, separator)]
  const baseURL = provider?.options?.baseURL
  let apiKey = provider?.options?.apiKey
  if (typeof apiKey === "string" && /^\{env:[^}]+\}$/u.test(apiKey)) {
    apiKey = process.env[apiKey.slice(5, -1)]
  }
  if (typeof baseURL !== "string" || typeof apiKey !== "string" || !apiKey) {
    throw new Error("Real smoke needs configured baseURL and apiKey (values are not logged)")
  }
  let calls = 0
  return {
    get calls() { return calls },
    async forward(body, response) {
      if (++calls > 3) throw new Error("Real smoke exceeded its three-request budget")
      process.stderr.write(`Real-provider smoke request ${calls}/3\n`)
      let upstream
      try {
        upstream = await fetch(`${baseURL.replace(/\/$/u, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ ...body, model: model.slice(separator + 1), max_tokens: 2048, stream: true }),
          signal: AbortSignal.timeout(60000),
        })
      } catch {
        throw new Error("Real-provider smoke network/timeout failure (credentials and endpoint omitted)")
      }
      if (!upstream.ok) {
        const error = await upstream.json().catch(() => null)
        const message = String(error?.error?.message ?? error?.message ?? "response omitted")
          .replaceAll(apiKey, "[key omitted]").replace(/Bearer\s+\S+/giu, "Bearer [omitted]")
          .replace(/sk-[\w-]+/giu, "[key omitted]").replace(/https?:\/\/\S+/giu, "[endpoint omitted]").slice(0, 500)
        throw new Error(`Real-provider smoke HTTP ${upstream.status}: ${message}`)
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      for await (const chunk of upstream.body) response.write(chunk)
      response.end()
    },
  }
}
