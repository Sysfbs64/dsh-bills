// ---------------------------------------------------------------------------
// dsh-bills — host half（常驻插件版）
// 模型用量账单：聚合会话日志中的模型调用 token 用量，按 DeepSeek 官方
// 峰谷价目表（人民币）逐次计价；增量同步（事件驱动 + 会话级 lastSeq
// 水位线轮询，非 live 历史会话永不重读）；v2 磁盘缓存常驻。
// Client 半部通过 webServer 路由 /api/dsh-bills/* 读取数据。
// ---------------------------------------------------------------------------

export const name = 'dsh-bills'
export const inject = ['timer', 'webServer']

// ---------------------------------------------------------------------------
// 定价表（人民币 / 百万 tokens）
// - DeepSeek：官方人民币价目表（api-docs.deepseek.com/zh-cn/quick_start/pricing），
//   峰谷定价于 2026-08-17 00:00（北京时间）生效；高峰 = 北京 09-12、14-18 点
//   （UTC 01-04、06-10），空闲 = 高峰的一半；生效前按官方旧价（legacy）。
//   自 2026-08-23 00:00（北京时间）起，周末（周六、周日，北京时间）全天为低谷价。
// - 其余模型：官方美元价按 1 USD = 6.79 CNY 折算（2026-08 央行中间价 6.7882）。
// ---------------------------------------------------------------------------
const DEEPSEEK_SINCE = Date.UTC(2026, 7, 16, 16, 0, 0)

// 周末全天低谷价生效时间 = 2026-08-23 00:00（北京时间）即 2026-08-22 16:00 UTC
const WEEKEND_OFFPEAK_SINCE = Date.UTC(2026, 7, 22, 16, 0, 0)

const PRICING = [
  { match: 'deepseek-v4-flash', since: DEEPSEEK_SINCE, legacy: { cacheHit: 0.02, cacheMiss: 1.0, out: 2.0 }, peak: { cacheHit: 0.1, cacheMiss: 3.0, out: 9.0 }, offPeak: { cacheHit: 0.05, cacheMiss: 1.5, out: 4.5 } },
  { match: 'deepseek-v4-pro', since: DEEPSEEK_SINCE, legacy: { cacheHit: 0.025, cacheMiss: 3.0, out: 6.0 }, peak: { cacheHit: 0.3, cacheMiss: 9.0, out: 27.0 }, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, out: 13.5 } },
  { match: 'gpt-5-mini', peak: { cacheHit: 0.8488, cacheMiss: 1.6975, out: 13.58 }, offPeak: { cacheHit: 0.8488, cacheMiss: 1.6975, out: 13.58 } },
  { match: 'gpt-5', peak: { cacheHit: 4.2438, cacheMiss: 8.4875, out: 67.9 }, offPeak: { cacheHit: 4.2438, cacheMiss: 8.4875, out: 67.9 } },
  { match: 'gpt-4.1-mini', peak: { cacheHit: 1.358, cacheMiss: 2.716, out: 10.864 }, offPeak: { cacheHit: 1.358, cacheMiss: 2.716, out: 10.864 } },
  { match: 'gpt-4.1-nano', peak: { cacheHit: 0.3395, cacheMiss: 0.679, out: 2.716 }, offPeak: { cacheHit: 0.3395, cacheMiss: 0.679, out: 2.716 } },
  { match: 'gpt-4.1', peak: { cacheHit: 6.79, cacheMiss: 13.58, out: 54.32 }, offPeak: { cacheHit: 6.79, cacheMiss: 13.58, out: 54.32 } },
  { match: 'gpt-4o-mini', peak: { cacheHit: 0.5093, cacheMiss: 1.0185, out: 4.074 }, offPeak: { cacheHit: 0.5093, cacheMiss: 1.0185, out: 4.074 } },
  { match: 'gpt-4o', peak: { cacheHit: 8.4875, cacheMiss: 16.975, out: 67.9 }, offPeak: { cacheHit: 8.4875, cacheMiss: 16.975, out: 67.9 } },
  { match: 'o4-mini', peak: { cacheHit: 3.7345, cacheMiss: 7.469, out: 29.876 }, offPeak: { cacheHit: 3.7345, cacheMiss: 7.469, out: 29.876 } },
  { match: 'claude-haiku-4', peak: { cacheHit: 0.679, cacheMiss: 6.79, out: 33.95 }, offPeak: { cacheHit: 0.679, cacheMiss: 6.79, out: 33.95 } },
  { match: 'claude-sonnet-4', peak: { cacheHit: 2.037, cacheMiss: 20.37, out: 101.85 }, offPeak: { cacheHit: 2.037, cacheMiss: 20.37, out: 101.85 } },
  { match: 'claude-opus-4', peak: { cacheHit: 10.185, cacheMiss: 101.85, out: 509.25 }, offPeak: { cacheHit: 10.185, cacheMiss: 101.85, out: 509.25 } },
  { match: 'claude-3-5-haiku', peak: { cacheHit: 0.5432, cacheMiss: 5.432, out: 27.16 }, offPeak: { cacheHit: 0.5432, cacheMiss: 5.432, out: 27.16 } },
  { match: 'claude-3-5-sonnet', peak: { cacheHit: 2.037, cacheMiss: 20.37, out: 101.85 }, offPeak: { cacheHit: 2.037, cacheMiss: 20.37, out: 101.85 } },
  { match: 'claude-3-7-sonnet', peak: { cacheHit: 2.037, cacheMiss: 20.37, out: 101.85 }, offPeak: { cacheHit: 2.037, cacheMiss: 20.37, out: 101.85 } },
  { match: 'gemini-2.5-pro', peak: { cacheHit: 8.4875, cacheMiss: 8.4875, out: 67.9 }, offPeak: { cacheHit: 8.4875, cacheMiss: 8.4875, out: 67.9 } },
  { match: 'gemini-2.5-flash', peak: { cacheHit: 2.037, cacheMiss: 2.037, out: 16.975 }, offPeak: { cacheHit: 2.037, cacheMiss: 2.037, out: 16.975 } },
  { match: 'gemini-2.0-flash', peak: { cacheHit: 0.679, cacheMiss: 0.679, out: 2.716 }, offPeak: { cacheHit: 0.679, cacheMiss: 0.679, out: 2.716 } },
  { match: 'gemini-1.5-pro', peak: { cacheHit: 8.4875, cacheMiss: 8.4875, out: 33.95 }, offPeak: { cacheHit: 8.4875, cacheMiss: 8.4875, out: 33.95 } },
  { match: 'gemini-1.5-flash', peak: { cacheHit: 0.5093, cacheMiss: 0.5093, out: 2.037 }, offPeak: { cacheHit: 0.5093, cacheMiss: 0.5093, out: 2.037 } },
  { match: 'mistral-large', peak: { cacheHit: 1.358, cacheMiss: 13.58, out: 40.74 }, offPeak: { cacheHit: 1.358, cacheMiss: 13.58, out: 40.74 } },
  { match: 'mistral-small', peak: { cacheHit: 0.3395, cacheMiss: 1.358, out: 4.074 }, offPeak: { cacheHit: 0.3395, cacheMiss: 1.358, out: 4.074 } },
]

// 高峰 = UTC 01:00-04:00、06:00-10:00（即北京时间 09-12、14-18 点）；
// 自 2026-08-23 00:00（北京时间）起，周末（周六、周日，北京时间）全天为低谷价。
function isPeak(ts) {
  if (ts >= WEEKEND_OFFPEAK_SINCE) {
    const dow = new Date(ts + 8 * 3600 * 1000).getUTCDay() // 北京时间星期几：0=周日，6=周六
    if (dow === 0 || dow === 6) return false
  }
  const h = new Date(ts).getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

// 某次调用（模型 + 时间戳）应使用的单价；未知模型返回 null
function priceFor(model, ts) {
  const m = String(model || '').toLowerCase()
  for (const p of PRICING) {
    if (m.indexOf(p.match) !== -1) {
      if (p.since !== undefined && ts < p.since && p.legacy) return p.legacy
      return isPeak(ts) ? p.peak : p.offPeak
    }
  }
  return null
}

// 北京时间（UTC+8）日期与小时
function beijingParts(ts) {
  const dt = new Date(ts + 8 * 3600 * 1000)
  return { date: dt.toISOString().slice(0, 10), hour: dt.getUTCHours() }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next
      next += 1
      out[i] = await fn(items[i], i)
    }
  }
  const n = Math.min(limit, items.length)
  const workers = []
  for (let k = 0; k < n; k += 1) workers.push(worker())
  await Promise.all(workers)
  return out
}

function freshState() {
  return {
    updatedAt: Date.now(),
    sessions: new Map(),
    global: {
      daily: new Map(),
      heat: new Map(),
      skills: new Map(),
      models: new Map(),
      hours: new Map(),
      days: new Map(),
    },
  }
}

function newSessionState(id, header) {
  return {
    lastSeq: 0,
    title: '',
    createdAt: (header && header.createdAt) || 0,
    origin: (header && header.origin) || 'session',
    provider: 'unknown',
    model: 'unknown',
    fold: { calls: 0, peakCalls: 0, offPeakCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, peakCost: 0, offPeakCost: 0 },
    models: new Map(),
    days: new Map(), // date(北京) -> { calls, cost, peakCost, offPeakCost, input, output, cacheRead, cacheWrite, reasoning }
  }
}

// 单事件折叠：会话状态 + 全局聚合（同步）
function foldEvent(s, g, e) {
  if (!e || typeof e !== 'object') return
  if (e.type === 'request/header' && e.data && e.data.header) {
    const cfg = e.data.header.config
    s.provider = (cfg && cfg.provider) || 'unknown'
    s.model = (cfg && cfg.model) || 'unknown'
    return
  }
  if (e.type === 'session/title' && e.data && typeof e.data.title === 'string') {
    s.title = e.data.title
    return
  }
  if (e.type === 'assistant/message' && e.data && e.data.usage) {
    const u = e.data.usage
    const ts = e.time || 0
    const provider = s.provider || 'unknown'
    const model = s.model || 'unknown'
    const input = u.inputTokens || 0
    const output = u.outputTokens || 0
    const cacheRead = u.cacheReadTokens || 0
    const cacheWrite = u.cacheWriteTokens || 0
    const reasoning = u.reasoningTokens || 0
    const tokens = input + output + cacheRead
    const p = priceFor(model, ts)
    const cost = p ? ((input + cacheWrite) * p.cacheMiss + cacheRead * p.cacheHit + output * p.out) / 1e6 : 0
    const peak = isPeak(ts)
    const mk = provider + '\u0000' + model
    const f = s.fold
    f.calls += 1
    f.input += input
    f.output += output
    f.cacheRead += cacheRead
    f.cacheWrite += cacheWrite
    f.reasoning += reasoning
    if (p) {
      f.cost = (f.cost === null ? 0 : f.cost) + cost
      if (peak) { f.peakCalls += 1; f.peakCost += cost } else { f.offPeakCalls += 1; f.offPeakCost += cost }
    } else if (peak) {
      f.peakCalls += 1
    } else {
      f.offPeakCalls += 1
    }
    let m = s.models.get(mk)
    if (!m) {
      m = { provider, model, calls: 0, peakCalls: 0, offPeakCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, peakCost: 0, offPeakCost: 0 }
      s.models.set(mk, m)
    }
    m.calls += 1
    m.input += input
    m.output += output
    m.cacheRead += cacheRead
    m.cacheWrite += cacheWrite
    m.reasoning += reasoning
    if (p) {
      m.cost = (m.cost === null ? 0 : m.cost) + cost
      if (peak) { m.peakCalls += 1; m.peakCost += cost } else { m.offPeakCalls += 1; m.offPeakCost += cost }
    } else if (peak) {
      m.peakCalls += 1
    } else {
      m.offPeakCalls += 1
    }
    const bp = beijingParts(ts)
    let sd = s.days.get(bp.date)
    if (!sd) { sd = { calls: 0, cost: 0, peakCost: 0, offPeakCost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }; s.days.set(bp.date, sd) }
    sd.calls += 1
    sd.input += input
    sd.output += output
    sd.cacheRead += cacheRead
    sd.cacheWrite += cacheWrite
    sd.reasoning += reasoning
    if (p) {
      sd.cost += cost
      if (peak) sd.peakCost += cost
      else sd.offPeakCost += cost
    }
    let dm = g.daily.get(bp.date)
    if (!dm) { dm = new Map(); g.daily.set(bp.date, dm) }
    let rec = dm.get(mk)
    if (!rec) { rec = { provider, model, cost: 0, calls: 0, peakCalls: 0, offPeakCalls: 0, peakCost: 0, offPeakCost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }; dm.set(mk, rec) }
    rec.cost += cost
    rec.calls += 1
    rec.input += input
    rec.output += output
    rec.cacheRead += cacheRead
    rec.cacheWrite += cacheWrite
    rec.reasoning += reasoning
    if (peak) { rec.peakCalls += 1; rec.peakCost += cost } else { rec.offPeakCalls += 1; rec.offPeakCost += cost }
    const hk = bp.date + '|' + bp.hour
    let h = g.heat.get(hk)
    if (!h) { h = { tokens: 0, calls: 0, cost: 0 }; g.heat.set(hk, h) }
    h.tokens += tokens
    h.calls += 1
    h.cost += cost
    let mm = g.models.get(mk)
    if (!mm) { mm = { provider, model, calls: 0, cost: 0 }; g.models.set(mk, mm) }
    mm.calls += 1
    mm.cost += cost
    let hh = g.hours.get(bp.hour)
    if (!hh) { hh = { calls: 0, tokens: 0 }; g.hours.set(bp.hour, hh) }
    hh.calls += 1
    hh.tokens += tokens
    let dd = g.days.get(bp.date)
    if (!dd) { dd = { calls: 0, tokens: 0, cost: 0 }; g.days.set(bp.date, dd) }
    dd.calls += 1
    dd.tokens += tokens
    dd.cost += cost
    return
  }
  if (e.type === 'tool/call' && e.data && e.data.name === 'skill') {
    let sname = null
    try {
      const args = JSON.parse(String(e.data.arguments || '{}'))
      sname = args && typeof args.name === 'string' ? args.name : null
    } catch (err) { sname = null }
    if (sname) {
      let sk = g.skills.get(sname)
      if (!sk) { sk = { calls: 0, lastAt: 0 }; g.skills.set(sname, sk) }
      sk.calls += 1
      if (e.time > sk.lastAt) sk.lastAt = e.time
    }
  }
}

// 按水位线折叠一批事件，返回实际折叠数
function foldEvents(s, g, events) {
  let n = 0
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const seq = typeof e.seq === 'number' ? e.seq : 0
    if (seq <= s.lastSeq) continue
    foldEvent(s, g, e)
    if (seq > s.lastSeq) s.lastSeq = seq
    n += 1
  }
  return n
}

export function apply(ctx) {
  const CACHE_FILE = '.bills-cache.json'
  const fsSvc = ctx.get('fs')
  const sp = ctx.get('sandboxPolicy')
  const workspaceRoot = sp ? sp.workspaceRoot : null
  let sessionCwd = null
  let state = null
  let activeCachePath = null
  let lastCacheError = null
  let syncChain = Promise.resolve()
  let syncStats = { fullScans: 0, incrementalSyncs: 0, eventsFolded: 0, syncMs: 0 }
  let persistTimer = null

  function currentCandidates() {
    const cands = []
    if (sessionCwd) cands.push(sessionCwd + '/' + CACHE_FILE)
    if (workspaceRoot) cands.push(workspaceRoot + '/' + CACHE_FILE)
    cands.push(CACHE_FILE)
    return [...new Set(cands)]
  }

  function writePolicy() {
    return { mode: 'workspace-write', workspaceRoot: sessionCwd || workspaceRoot || '.' }
  }

  async function forEachCandidate(fn) {
    if (!fsSvc) return null
    for (const p of currentCandidates()) {
      try {
        const t = await fsSvc.resolve(p)
        const r = await fn(t, p)
        if (r) return r
      } catch (err) {
        lastCacheError = String(err && err.message ? err.message : err)
      }
    }
    return null
  }

  function serializeState() {
    const s = state
    const sessions = {}
    for (const [id, sess] of s.sessions) {
      sessions[id] = {
        lastSeq: sess.lastSeq,
        title: sess.title,
        createdAt: sess.createdAt,
        origin: sess.origin,
        provider: sess.provider,
        model: sess.model,
        fold: sess.fold,
        models: [...sess.models.values()].map((m) => ({ ...m })),
        days: [...sess.days.entries()].map(([date, v]) => ({ date, ...v })),
      }
    }
    const g = s.global
    return {
      version: 4,
      updatedAt: s.updatedAt,
      sessions,
      global: {
        daily: [...g.daily.entries()].map(([date, ms]) => ({ date, models: [...ms.values()].map((m) => ({ ...m })) })),
        heat: [...g.heat.entries()].map(([k, v]) => ({ k, ...v })),
        skills: [...g.skills.entries()].map(([k, v]) => ({ k, ...v })),
        models: [...g.models.entries()].map(([k, v]) => ({ k, ...v })),
        hours: [...g.hours.entries()].map(([k, v]) => ({ k, ...v })),
        days: [...g.days.entries()].map(([k, v]) => ({ k, ...v })),
      },
    }
  }

  async function persist() {
    if (!state) return
    lastCacheError = null
    const payload = JSON.stringify(serializeState())
    await forEachCandidate(async (t, p) => {
      try {
        await fsSvc.writeText(t, payload, undefined, undefined, writePolicy())
        activeCachePath = p
        return true
      } catch (err) {
        lastCacheError = String(err && err.message ? err.message : err)
        return false
      }
    })
  }

  function schedulePersist() {
    if (persistTimer) return
    persistTimer = ctx.timeout(() => {
      persistTimer = null
      persist()
    }, 30000)
  }

  async function loadDisk() {
    await forEachCandidate(async (t) => {
      try {
        const text = await fsSvc.readText(t)
        const data = JSON.parse(text)
        if (data && data.version === 4 && data.sessions && data.global) {
          if (!state) {
            state = freshState()
            state.updatedAt = data.updatedAt || Date.now()
            for (const [id, raw] of Object.entries(data.sessions)) {
              const sess = newSessionState(id, null)
              sess.lastSeq = raw.lastSeq || 0
              sess.title = raw.title || ''
              sess.createdAt = raw.createdAt || 0
              sess.origin = raw.origin || 'session'
              sess.provider = raw.provider || 'unknown'
              sess.model = raw.model || 'unknown'
              sess.fold = raw.fold || sess.fold
              for (const m of raw.models || []) sess.models.set(m.provider + '\u0000' + m.model, m)
              for (const d of raw.days || []) {
                if (!d || typeof d.date !== 'string') continue
                sess.days.set(d.date, {
                  calls: d.calls || 0, cost: d.cost || 0, peakCost: d.peakCost || 0, offPeakCost: d.offPeakCost || 0,
                  input: d.input || 0, output: d.output || 0, cacheRead: d.cacheRead || 0, cacheWrite: d.cacheWrite || 0, reasoning: d.reasoning || 0,
                })
              }
              state.sessions.set(id, sess)
            }
            const g = state.global
            for (const row of data.global.daily || []) {
              const ms = new Map()
              for (const m of row.models || []) ms.set(m.provider + '\u0000' + m.model, m)
              g.daily.set(row.date, ms)
            }
            for (const row of data.global.heat || []) g.heat.set(row.k, { tokens: row.tokens, calls: row.calls, cost: row.cost })
            for (const row of data.global.skills || []) g.skills.set(row.k, { calls: row.calls, lastAt: row.lastAt })
            for (const row of data.global.models || []) g.models.set(row.k, { provider: row.provider, model: row.model, calls: row.calls, cost: row.cost })
            for (const row of data.global.hours || []) g.hours.set(Number(row.k), { calls: row.calls, tokens: row.tokens })
            for (const row of data.global.days || []) g.days.set(row.k, { calls: row.calls, tokens: row.tokens, cost: row.cost })
            activeCachePath = t.displayPath || null
          }
          return true
        }
      } catch (err) { /* 无缓存或版本不符：忽略，触发基线 */ }
      return false
    })
  }

  // 启动基线 / 60s 轮询：只处理新会话（全量）与 live 会话（增量，轻量检测变化）；
  // 非 live 已缓存会话永不重读；无变化时零操作（不更新 updatedAt、不写盘）。
  async function incrementalSync(isInit) {
    const sq = ctx.get('sessionQuery')
    if (sq === undefined) return
    const records = await sq.listSessions()
    const t0 = Date.now()
    if (!sessionCwd) {
      const hit = records.find((r) => r.live && r.header && r.header.cwd)
      if (hit && hit.header.cwd) sessionCwd = hit.header.cwd
    }
    let changed = false
    const seen = new Set(records.map((r) => r.header.id))
    for (const id of state.sessions.keys()) {
      if (!seen.has(id)) {
        state.sessions.delete(id)
        changed = true
      }
    }
    const jobs = []
    for (const rec of records) {
      const id = rec.header.id
      const existing = state.sessions.get(id)
      if (existing && !rec.live) continue // 非 live 已缓存：永不重读
      if (existing && rec.live) {
        const latest = await sq.listEvents(id).then((es) => (es && es.length ? es[es.length - 1].seq : 0), () => 1e12)
        if (latest <= existing.lastSeq) continue
      }
      jobs.push(rec)
    }
    await mapLimit(jobs, 3, async (rec) => {
      const id = rec.header.id
      let sess = state.sessions.get(id)
      if (!sess) {
        sess = newSessionState(id, rec.header)
        state.sessions.set(id, sess)
      }
      const [title, log] = await Promise.all([
        sq.readTitle(id).then((t) => (t ? t.title : ''), () => ''),
        sq.readSession(id).then((s) => s, () => null),
      ])
      if (!log) return
      if (title) sess.title = title
      const n = foldEvents(sess, state.global, log.events || [])
      if (n > 0) changed = true
    })
    syncStats.incrementalSyncs += 1
    syncStats.syncMs = Date.now() - t0
    if (isInit) syncStats.fullScans += 1
    if (isInit || changed) {
      state.updatedAt = Date.now()
      await persist()
    }
  }

  function deriveTotals(sessionsArr) {
    const totals = {
      sessions: sessionsArr.length, calls: 0, peakCalls: 0, offPeakCalls: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      cost: null, peakCost: 0, offPeakCost: 0, unknownCostSessions: 0,
    }
    for (const s of sessionsArr) {
      totals.calls += s.calls
      totals.peakCalls += s.peakCalls
      totals.offPeakCalls += s.offPeakCalls
      totals.input += s.input
      totals.output += s.output
      totals.cacheRead += s.cacheRead
      totals.cacheWrite += s.cacheWrite
      totals.reasoning += s.reasoning
      if (s.cost !== null) {
        totals.cost = (totals.cost === null ? 0 : totals.cost) + s.cost
        totals.peakCost += s.peakCost
        totals.offPeakCost += s.offPeakCost
      } else {
        totals.unknownCostSessions += 1
      }
    }
    return totals
  }

  function deriveSummary() {
    const sessions = []
    for (const [id, sess] of state.sessions) {
      if (!sess.fold || sess.fold.calls <= 0) continue
      const models = [...sess.models.values()].sort((a, b) => {
        const ca = a.cost === null ? -1 : a.cost
        const cb = b.cost === null ? -1 : b.cost
        return cb - ca || b.calls - a.calls
      })
      sessions.push(Object.assign({ sessionId: id }, sess.fold, {
        title: sess.title, createdAt: sess.createdAt, origin: sess.origin, models,
        days: [...sess.days.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? -1 : 1)),
      }))
    }
    sessions.sort((a, b) => {
      const ca = a.cost === null ? -1 : a.cost
      const cb = b.cost === null ? -1 : b.cost
      return cb - ca || b.calls - a.calls
    })
    return {
      generatedAt: Date.now(),
      currency: 'CNY',
      currencyLabel: '人民币 (CNY)',
      estimate: true,
      pricing: {
        effectiveAt: DEEPSEEK_SINCE,
        effectiveLabel: '2026-08-17 00:00（北京时间）',
        peakLabel: 'DeepSeek 高峰时段 = 北京时间 09:00–12:00、14:00–18:00（UTC 01:00–04:00、06:00–10:00）；自 2026-08-23（北京时间）起周末（周六、周日）全天为低谷价',
        exchangeNote: '其余模型按 1 USD ≈ 6.79 CNY 折算（2026-08 央行中间价）',
      },
      totals: deriveTotals(sessions),
      sessions,
    }
  }

  function deriveCharts() {
    const g = state.global
    const daily = [...g.daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, ms]) => {
      const models = [...ms.values()].map((m) => ({
        provider: m.provider, model: m.model, cost: m.cost, calls: m.calls,
        peakCalls: m.peakCalls, offPeakCalls: m.offPeakCalls, peakCost: m.peakCost, offPeakCost: m.offPeakCost,
        input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, reasoning: m.reasoning,
      })).sort((a, b) => b.cost - a.cost)
      const total = models.reduce((s, m) => s + m.cost, 0)
      return { date, models, total }
    })
    const heat = [...g.heat.entries()].map(([k, v]) => {
      const sep = k.indexOf('|')
      return { date: k.slice(0, sep), hour: Number(k.slice(sep + 1)), tokens: v.tokens, calls: v.calls, cost: v.cost }
    }).sort((a, b) => (a.date === b.date ? a.hour - b.hour : (a.date < b.date ? -1 : 1)))
    const skills = [...g.skills.entries()].map(([k, v]) => ({ name: k, calls: v.calls, lastAt: v.lastAt })).sort((a, b) => b.calls - a.calls)
    const topModels = [...g.models.values()].sort((a, b) => b.calls - a.calls || b.cost - a.cost).slice(0, 5).map((m) => ({ provider: m.provider, model: m.model, calls: m.calls, cost: m.cost }))
    const topHours = [...g.hours.entries()].map(([hour, v]) => ({ hour, calls: v.calls, tokens: v.tokens })).sort((a, b) => b.calls - a.calls).slice(0, 3)
    const dayArr = [...g.days.entries()].map(([date, v]) => ({ date, calls: v.calls, tokens: v.tokens, cost: v.cost })).sort((a, b) => (a.date < b.date ? -1 : 1))
    const busiest = dayArr.slice().sort((a, b) => b.calls - a.calls)[0] || null
    const dayCount = dayArr.filter((d) => d.calls > 0).length
    const totalCost = dayArr.reduce((s, d) => s + d.cost, 0)
    const totalCalls = dayArr.reduce((s, d) => s + d.calls, 0)
    return { daily, heat, skills, topModels, topHours, busiest, dayCount, totalCost, totalCalls }
  }

  function cachedResponse(kind) {
    if (!state) return null
    const body = kind === 'summary' ? deriveSummary() : deriveCharts()
    body.cachedAt = state.updatedAt
    if (kind === 'summary') {
      body.cacheDebug = {
        cachePath: activeCachePath,
        candidates: currentCandidates(),
        workspaceRoot: workspaceRoot,
        sessionCwd: sessionCwd,
        hasFs: !!fsSvc,
        hasSandboxPolicy: !!sp,
        lastError: lastCacheError,
        syncStats: Object.assign({}, syncStats, { sessions: state.sessions.size }),
      }
    }
    return body
  }

  // HTTP 路由（client 半部同源 fetch）
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-bills/summary',
    handler: async (req, res) => {
      const hit = cachedResponse('summary')
      if (hit) return json(res, 200, hit)
      await syncChain.then(() => incrementalSync(true))
      json(res, 200, cachedResponse('summary') || { error: '账单缓存初始化失败' })
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-bills/charts',
    handler: async (req, res) => {
      const hit = cachedResponse('charts')
      if (hit) return json(res, 200, hit)
      await syncChain.then(() => incrementalSync(true))
      json(res, 200, cachedResponse('charts') || { error: '账单缓存初始化失败' })
    },
  })

  // 生命周期：加载磁盘缓存 → 基线增量同步 → 60s 增量轮询 + 事件驱动实时增量
  loadDisk().then(() => {
    if (!state) state = freshState()
    return incrementalSync(true)
  })
  ctx.interval(() => { syncChain = syncChain.then(() => incrementalSync(false)) }, 60000)
  // 宿主 ctx 监听所有会话事件（无 scope 限制），seq 去重
  ctx.on('session/event', (session, event) => {
    if (!state) return
    const id = session && session.id ? session.id : null
    if (!id) return
    let sess = state.sessions.get(id)
    if (!sess) {
      sess = newSessionState(id, session.header)
      state.sessions.set(id, sess)
    }
    const seq = event && typeof event.seq === 'number' ? event.seq : 0
    if (seq <= sess.lastSeq) return
    foldEvent(sess, state.global, event)
    sess.lastSeq = seq
    state.updatedAt = Date.now()
    syncStats.eventsFolded += 1
    schedulePersist()
  })
}
