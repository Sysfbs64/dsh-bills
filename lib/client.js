// dsh-bills — client half（常驻插件版）
// 会话标签页「账单」视图 + 会话头部「账单」按钮：
// 汇总卡片 / 按天分模型柱状图 / token 热力图 / 按会话明细表（紧随热力图）/
// 常用数据汇总 / skills，全部支持 7d / 14d / 30d / 自定义时间窗口（默认 7 天）。
// 数据经同源 fetch 读取宿主路由 /api/dsh-bills/*（增量缓存派生，毫秒级）。
window.__ModuleLoader__.load({
  id: 'dsh-bills',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    function fmtTokens(n) {
      n = Number(n) || 0
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(n)
    }

    function fmtExact(n) {
      return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtCost(n) {
      if (n === null || n === undefined) return '—'
      if (n === 0) return '¥0'
      if (n < 1) return '¥' + n.toFixed(4)
      return '¥' + n.toFixed(2)
    }

    const PROVIDER_HUES = {
      'deepseek-official': 231, deepseek: 231, openai: 160, anthropic: 24, google: 272, mistral: 12, groq: 8, openrouter: 262, together: 200,
    }
    const FALLBACK_HUES = [231, 160, 24, 272, 12, 200, 320, 90]

    function hashStr(s) {
      let h = 0
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
      return h
    }

    function providerHue(provider) {
      if (PROVIDER_HUES[provider] !== undefined) return PROVIDER_HUES[provider]
      return FALLBACK_HUES[hashStr(String(provider)) % FALLBACK_HUES.length]
    }

    function modelTier(model) {
      const m = String(model || '').toLowerCase()
      if (/(pro|opus|ultra|max|large|big)/.test(m)) return 0
      if (/(flash|mini|nano|haiku|small|lite|light|slim|turbo|fast)/.test(m)) return 2
      return 1
    }

    function modelColor(provider, model) {
      const hue = providerHue(provider)
      const tier = modelTier(model)
      const baseLight = tier === 0 ? 40 : tier === 1 ? 54 : 68
      const delta = (hashStr(String(provider) + '|' + String(model)) % 3 - 1) * 7
      const light = Math.max(28, Math.min(82, baseLight + delta))
      return 'hsl(' + hue + ', 65%, ' + light + '%)'
    }

    function heatColor(ratio) {
      const steps = ['rgba(77,107,254,0.08)', 'rgba(77,107,254,0.25)', 'rgba(77,107,254,0.45)', 'rgba(77,107,254,0.7)', 'rgba(77,107,254,0.95)']
      const idx = ratio <= 0.05 ? 0 : ratio < 0.3 ? 1 : ratio < 0.55 ? 2 : ratio < 0.8 ? 3 : 4
      return steps[idx]
    }

    function weekdayOf(dateStr) {
      const t = new Date(dateStr + 'T00:00:00+08:00').getTime()
      return ['日', '一', '二', '三', '四', '五', '六'][new Date(t + 8 * 3600 * 1000).getUTCDay()]
    }

    // ---------- 时间窗口（北京时间日期字符串） ----------
    function bjToday() {
      return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    }

    function addDays(dateStr, n) {
      const d = new Date(dateStr + 'T00:00:00+08:00')
      d.setUTCDate(d.getUTCDate() + n)
      return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    }

    function inRange(dateStr, start, end) {
      return dateStr >= start && dateStr <= end
    }

    function presetRange(preset) {
      const end = bjToday()
      if (preset === 'custom') return null
      return { start: addDays(end, -(Number(preset) - 1)), end }
    }

    function WindowBar(props) {
      const win = props.win
      const btns = [7, 14, 30, 'custom'].map((n) => React.createElement('button', {
        key: String(n),
        type: 'button',
        className: 'bills-day-btn' + (win.preset === n ? ' active' : ''),
        onClick: () => {
          if (n === 'custom') { props.onWin({ preset: 'custom', start: win.start, end: win.end }) }
          else { const r = presetRange(n); props.onWin({ preset: n, start: r.start, end: r.end }) }
        },
      }, n === 'custom' ? '自定义' : n + ' 天'))
      const custom = win.preset === 'custom'
        ? React.createElement('span', { className: 'bills-win-custom' },
          React.createElement('input', {
            type: 'date', className: 'bills-win-date', value: win.start || '', max: win.end || undefined,
            onChange: (ev) => { const v = ev.target.value; if (v) props.onWin({ preset: 'custom', start: v, end: v > win.end ? v : win.end }) },
          }),
          React.createElement('span', { className: 'bills-win-sep' }, '至'),
          React.createElement('input', {
            type: 'date', className: 'bills-win-date', value: win.end || '', min: win.start || undefined,
            onChange: (ev) => { const v = ev.target.value; if (v) props.onWin({ preset: 'custom', start: win.start && win.start <= v ? win.start : v, end: v }) },
          }))
        : null
      return React.createElement('div', { className: 'bills-windowbar' },
        React.createElement('span', { className: 'bills-windowbar-label' }, '阅览窗口'),
        btns,
        custom,
        React.createElement('span', { className: 'bills-window-range' },
          (win.start || '—') + ' ~ ' + (win.end || '—') + '（北京时间）'))
    }

    // ---------- 悬浮层：测量后夹取在面板/视口内，避免边缘溢出被裁剪 ----------
    function useTip(wrapRef) {
      const [tip, setTip] = React.useState(null)
      const [pos, setPos] = React.useState(null)
      const tipRef = React.useRef(null)
      React.useLayoutEffect(() => {
        if (!tip) { setPos(null); return }
        const el = tipRef.current
        const wrap = wrapRef.current
        if (!el || !wrap) { setPos(null); return }
        const w = el.offsetWidth
        const h = el.offsetHeight
        const pr = wrap.getBoundingClientRect()
        const pad = 8
        let left = tip.x
        let top = tip.y
        let transform = tip.dir === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'
        if (w <= pr.width) {
          const half = w / 2
          left = Math.min(Math.max(left, half + pad), Math.max(half + pad, pr.width - half - pad))
        } else {
          left = pr.width / 2
          transform = 'translate(-50%, 0)'
        }
        const tipTopV = pr.top + (tip.dir === 'bottom' ? top + 16 : top - 8 - h)
        if (tip.dir === 'bottom' && tipTopV + h > window.innerHeight - 4 && top - 8 - h >= 0) {
          top = top - 8
          transform = 'translate(-50%, -100%)'
        } else if (tip.dir === 'top' && tipTopV < 4 && top + 16 + h <= pr.height) {
          top = top + 16
          transform = 'translate(-50%, 0)'
        }
        setPos({ left: left, top: top, transform: transform })
      }, [tip])
      return { tip: tip, setTip: setTip, tipRef: tipRef, pos: pos }
    }

    // ---------- 汇总卡片 ----------
    function CardsPanel(props) {
      const t = props.totals
      const moneyKeys = { cost: 1, peakCost: 1, offPeakCost: 1 }
      const labels = { sessions: '会话数', calls: '调用次数', input: '输入 tokens', output: '输出 tokens', cacheRead: '缓存读 tokens', reasoning: '推理 tokens', peakCost: '高峰费用 (CNY)', offPeakCost: '空闲费用 (CNY)', cost: '估算费用 (CNY)' }
      const card = (key, label) => React.createElement('div', { className: 'bills-card', key: key },
        React.createElement('div', { className: 'k' }, label),
        React.createElement('div', { className: 'v' + (key === 'cost' ? ' cost' : '') }, key === 'sessions' ? String(t.sessions) : moneyKeys[key] ? fmtCost(t[key]) : fmtTokens(t[key])))
      const keys = ['sessions', 'calls', 'input', 'output', 'cacheRead', 'reasoning', 'peakCost', 'offPeakCost', 'cost']
      return React.createElement('div', { className: 'bills-cards' }, keys.map((key) => card(key, labels[key])))
    }

    // ---------- 按天分模型柱状图 ----------
    function BarPanel(props) {
      const data = props.data || []
      const max = data.reduce((m, d) => Math.max(m, d.total || 0), 0)
      const wrapRef = React.useRef(null)
      const tipState = useTip(wrapRef)
      const seen = []
      const seenKey = {}
      for (const d of data) {
        for (const m of d.models || []) {
          const k = m.provider + '\u0000' + m.model
          if (!seenKey[k]) { seenKey[k] = 1; seen.push({ provider: m.provider, model: m.model }) }
        }
      }
      const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => ({ f: f, v: max * f }))
      const grid = ticks.map((t) => React.createElement('div', { key: t.f, className: 'bills-gridline', style: { bottom: t.f * 100 + '%' } }))
      const yLabels = ticks.map((t) => React.createElement('div', { key: t.f, className: 'bills-y-label', style: { bottom: t.f * 100 + '%' } }, t.v > 0 ? fmtCost(t.v) : '0'))
      const pos = (ev) => {
        if (!wrapRef.current) return null
        const r = ev.currentTarget.getBoundingClientRect()
        const pr = wrapRef.current.getBoundingClientRect()
        return { x: r.left - pr.left + r.width / 2, y: r.top - pr.top, dir: r.top - pr.top > 150 ? 'top' : 'bottom' }
      }
      const tip = tipState.tip
      const dayTipNode = tip && tip.kind === 'day'
        ? React.createElement('div', { className: 'bills-tip', ref: tipState.tipRef, style: tipState.pos },
          React.createElement('div', { className: 'bills-tip-title' }, tip.day.date + ' 周' + weekdayOf(tip.day.date)),
          (tip.day.models || []).map((m) => React.createElement('div', { className: 'bills-tip-row', key: m.provider + '\u0000' + m.model },
            React.createElement('span', null, m.model),
            React.createElement('span', { className: 'b' }, fmtCost(m.cost)))),
          React.createElement('div', { className: 'bills-tip-row' },
            React.createElement('span', { style: { fontWeight: 600 } }, '合计'),
            React.createElement('span', { className: 'b', style: { fontWeight: 600 } }, fmtCost(tip.day.total))))
        : null
      const segTipNode = tip && tip.kind === 'seg'
        ? React.createElement('div', { className: 'bills-tip', ref: tipState.tipRef, style: tipState.pos },
          React.createElement('div', { className: 'bills-tip-title' }, tip.day.date + ' 周' + weekdayOf(tip.day.date)),
          React.createElement('div', { className: 'bills-tip-row' },
            React.createElement('span', { className: 'bills-mini-key' },
              React.createElement('span', { className: 'bills-dot', style: { background: modelColor(tip.model.provider, tip.model.model) } }),
              tip.model.model),
            React.createElement('span', { className: 'b' }, fmtCost(tip.model.cost))),
          React.createElement('div', { className: 'bills-tip-row' },
            React.createElement('span', null, '服务商'),
            React.createElement('span', { className: 'b' }, tip.model.provider)),
          React.createElement('div', { className: 'bills-tip-row' },
            React.createElement('span', null, '当日占比'),
            React.createElement('span', { className: 'b' }, (tip.day.total > 0 ? (tip.model.cost / tip.day.total) * 100 : 0).toFixed(1) + '%')),
          React.createElement('div', { className: 'bills-tip-row' },
            React.createElement('span', null, '调用次数'),
            React.createElement('span', { className: 'b' }, (tip.model.calls || 0) + ' 次')))
        : null
      const body = data.length
        ? React.createElement('div', { className: 'bills-bars' },
          data.map((d) => {
            const pct = max > 0 ? Math.max((d.total || 0) / max * 100, (d.total || 0) > 0 ? 2 : 0) : 0
            return React.createElement('div', {
              className: 'bills-bar-col',
              key: d.date,
              onMouseMove: (ev) => { const p = pos(ev); if (p) tipState.setTip({ kind: 'day', x: p.x, y: p.y, dir: p.dir, day: d }) },
              onMouseLeave: () => tipState.setTip(null),
            },
              React.createElement('div', { className: 'bills-bar', style: { height: pct + '%' } },
                (d.models || []).map((m, i) => React.createElement('div', {
                  key: i,
                  className: 'bills-bar-seg' + ((m.cost || 0) > 0 ? ' hoverable' : ''),
                  style: { height: (d.total ? (m.cost / d.total) * 100 : 0) + '%', background: modelColor(m.provider, m.model) },
                  onMouseMove: (ev) => {
                    ev.stopPropagation()
                    const p = pos(ev)
                    if (p) tipState.setTip({ kind: 'seg', x: p.x, y: p.y, dir: p.dir, model: m, day: d })
                  },
                  onMouseLeave: () => tipState.setTip(null),
                })),
              ),
              React.createElement('div', { className: 'bills-bar-label' }, d.date.slice(5)),
            )
          }),
        )
        : React.createElement('div', { className: 'bills-empty' }, '窗口内暂无数据')
      return React.createElement('div', { className: 'bills-panel', ref: wrapRef },
        React.createElement('div', { className: 'bills-panel-head' },
          React.createElement('div', { className: 'bills-panel-title' }, '账单柱状图（按天花费，分模型）', props.range ? React.createElement('span', { className: 'bills-range' }, props.range) : null)),
        React.createElement('div', { className: 'bills-chart-wrap' },
          React.createElement('div', { className: 'bills-chart-y' }, yLabels),
          React.createElement('div', { className: 'bills-chart-area' },
            grid,
            body,
          ),
        ),
        dayTipNode,
        segTipNode,
        React.createElement('div', { className: 'bills-legend' },
          seen.map((s) => React.createElement('span', { className: 'bills-legend-item', key: s.provider + '\u0000' + s.model },
            React.createElement('span', { className: 'bills-dot', style: { background: modelColor(s.provider, s.model) } }),
            s.model)),
        ),
      )
    }

    // ---------- Token 热力图 ----------
    function HeatPanel(props) {
      const heat = props.heat || []
      const dates = [...new Set(heat.map((c) => c.date))].sort()
      const byKey = new Map(heat.map((c) => [c.date + '|' + c.hour, c]))
      const max = heat.reduce((m, c) => Math.max(m, c.tokens || 0), 0)
      const wrapRef = React.useRef(null)
      const tipState = useTip(wrapRef)
      const hLabels = [0, 3, 6, 9, 12, 15, 18, 21, 23].map((h) => React.createElement('span', { key: 'h' + h, className: 'bills-heat-hlabel', style: { gridColumn: h + 2 } }, h))
      const rows = dates.map((date) => {
        const cells = []
        for (let h = 0; h < 24; h += 1) {
          const c = byKey.get(date + '|' + h)
          const ratio = max > 0 ? (c ? c.tokens / max : 0) : 0
          const move = (ev) => {
            if (!c || !wrapRef.current) return
            const r = ev.currentTarget.getBoundingClientRect()
            const pr = wrapRef.current.getBoundingClientRect()
            tipState.setTip({ x: r.left - pr.left + r.width / 2, y: r.top - pr.top, cell: c, date: date, hour: h, dir: r.top - pr.top > 90 ? 'top' : 'bottom' })
          }
          cells.push(React.createElement('div', {
            key: h,
            className: 'bills-heat-cell' + (c ? ' hoverable' : ''),
            style: { background: c ? heatColor(ratio) : 'var(--dsw-alias-bg-layer-2)' },
            onMouseMove: c ? move : null,
            onMouseLeave: c ? () => tipState.setTip(null) : null,
          }))
        }
        return React.createElement(React.Fragment, { key: date },
          React.createElement('span', { className: 'bills-heat-rowlabel' }, date.slice(5) + ' 周' + weekdayOf(date)),
          cells,
        )
      })
      const tip = tipState.tip
      const tipNode = tip ? React.createElement('div', { className: 'bills-tip', ref: tipState.tipRef, style: tipState.pos },
        React.createElement('div', { className: 'bills-tip-title' }, tip.date + ' ' + tip.hour + ':00'),
        React.createElement('div', { className: 'bills-tip-row' },
          React.createElement('span', null, 'Tokens'),
          React.createElement('span', { className: 'b' }, fmtExact(tip.cell.tokens))),
        React.createElement('div', { className: 'bills-tip-row' },
          React.createElement('span', null, '调用'),
          React.createElement('span', { className: 'b' }, tip.cell.calls + ' 次')),
        React.createElement('div', { className: 'bills-tip-row' },
          React.createElement('span', null, '花费'),
          React.createElement('span', { className: 'b' }, fmtCost(tip.cell.cost)))) : null
      const body = dates.length
        ? React.createElement('div', { className: 'bills-heat' }, React.createElement('span', null), hLabels, rows)
        : React.createElement('div', { className: 'bills-empty' }, '窗口内暂无数据')
      return React.createElement('div', { className: 'bills-panel', ref: wrapRef },
        React.createElement('div', { className: 'bills-panel-head' },
          React.createElement('div', { className: 'bills-panel-title' }, 'Token 使用热力图（' + (props.range || '') + ' × 24 小时）')),
        body,
        tipNode,
        React.createElement('div', { className: 'bills-heat-legend' },
          React.createElement('span', null, '低'),
          ['rgba(77,107,254,0.08)', 'rgba(77,107,254,0.25)', 'rgba(77,107,254,0.45)', 'rgba(77,107,254,0.7)', 'rgba(77,107,254,0.95)'].map((c) => React.createElement('span', { key: c, className: 'bills-heat-cell', style: { background: c, display: 'inline-block', width: 12, height: 12 } })),
          React.createElement('span', null, '高'),
          React.createElement('span', { style: { marginLeft: 10 } }, '悬停查看具体 token 数值与花费；颜色深浅 = 当日该小时 token 使用量')),
      )
    }

    // ---------- 账单缓存位置（自定义路径，默认 $DSH_HOME/profiles） ----------
    function CacheConfigRow(props) {
      const [value, setValue] = React.useState((props.cfg && props.cfg.cacheDir) || '')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { setValue((props.cfg && props.cfg.cacheDir) || '') }, [props.cfg])
      const pick = () => {
        if (!props.pickDirectory) { setMsg('当前环境不支持系统文件夹选择器，请手动输入绝对路径'); return }
        setBusy(true)
        setMsg(null)
        Promise.resolve(props.pickDirectory()).then((dir) => {
          setBusy(false)
          if (dir) { setValue(dir); setMsg('已选择：' + dir + '（点击保存生效）') }
        }).catch((e) => {
          setBusy(false)
          setMsg('选择失败：' + ((e && e.message) || String(e)))
        })
      }
      const save = (dir) => {
        setBusy(true)
        setMsg(null)
        fetch('/api/dsh-bills/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cacheDir: dir }),
        }).then((r) => r.json()).then((info) => {
          setBusy(false)
          if (info && info.error) { setMsg('保存失败：' + info.error); return }
          setValue((info && info.cacheDir) || '')
          setMsg('已生效：' + ((info && info.cacheFile) || ''))
          if (props.onSaved) props.onSaved(info)
        }).catch((e) => {
          setBusy(false)
          setMsg('保存失败：' + ((e && e.message) || String(e)))
        })
      }
      return React.createElement('div', { className: 'bills-panel bills-cachecfg' },
        React.createElement('div', { className: 'bills-panel-head' },
          React.createElement('div', { className: 'bills-panel-title' }, '账单缓存位置',
            React.createElement('span', { className: 'bills-range' }, '默认为 ' + ((props.cfg && props.cfg.defaultCacheDir) || '$DSH_HOME/profiles')))),
        React.createElement('div', { className: 'bills-cachecfg-row' },
          React.createElement('input', {
            type: 'text',
            readOnly: true,
            className: 'bills-win-date bills-cachecfg-input',
            value: value,
            placeholder: (props.cfg && props.cfg.defaultCacheDir) || '绝对路径',
            spellCheck: false,
            title: '点击「浏览…」通过系统文件夹选择器选择',
          }),
          React.createElement('button', { type: 'button', className: 'bills-refresh', disabled: busy, onClick: pick }, '浏览…'),
          React.createElement('button', { type: 'button', className: 'bills-refresh', disabled: busy, onClick: () => save(value.trim() || null) }, '保存'),
          React.createElement('button', { type: 'button', className: 'bills-day-btn', disabled: busy, onClick: () => save(null) }, '恢复默认'),
          msg ? React.createElement('span', { className: 'bills-cachecfg-msg' }, msg) : null),
      )
    }

    // ---------- 按会话统计明细（紧随热力图；默认近 7 天窗口） ----------
    function SessionsPanel(props) {
      const rows = props.rows || []
      const [expanded, setExpanded] = React.useState({})
      const body = []
      for (const s of rows) {
        const open = !!expanded[s.sessionId]
        body.push(React.createElement('tr', {
          key: s.sessionId,
          className: 'row-click',
          onClick: () => setExpanded((p) => {
            const n = Object.assign({}, p)
            n[s.sessionId] = !open
            return n
          }),
        },
          React.createElement('td', null,
            React.createElement('span', null, s.title || '未命名会话'),
            s.origin === 'subagent' ? React.createElement('span', { className: 'bills-badge' }, '子代理') : null),
          React.createElement('td', { className: 'bills-num' }, String(s.calls)),
          React.createElement('td', { className: 'bills-num' }, fmtTokens(s.input)),
          React.createElement('td', { className: 'bills-num' }, fmtTokens(s.output)),
          React.createElement('td', { className: 'bills-num' }, fmtTokens(s.cacheRead)),
          React.createElement('td', { className: 'bills-num' }, fmtTokens(s.reasoning)),
          React.createElement('td', { className: 'bills-num' },
            React.createElement('div', null, fmtCost(s.cost)),
            React.createElement('div', { className: 'bills-cost-sub' }, '峰 ' + fmtCost(s.peakCost) + ' / 谷 ' + fmtCost(s.offPeakCost))),
          React.createElement('td', { className: 'bills-expand' }, open ? '▾ 收起' : '▸ 明细'),
        ))
        if (open) {
          const headerLine = React.createElement('div', { className: 'bills-model-line bills-day-line', style: { marginTop: 0, opacity: 0.85 } },
            React.createElement('span', null, '日期'),
            React.createElement('span', { className: 'bills-num' }, '调用'),
            React.createElement('span', { className: 'bills-num' }, '输入'),
            React.createElement('span', { className: 'bills-num' }, '输出'),
            React.createElement('span', { className: 'bills-num' }, '缓存读'),
            React.createElement('span', { className: 'bills-num' }, '推理'),
            React.createElement('span', { className: 'bills-num' }, '费用'))
          const lines = (s.days || []).map((d) => React.createElement('div', { className: 'bills-model-line bills-day-line', key: d.date },
            React.createElement('span', { className: 'm' }, d.date + ' 周' + weekdayOf(d.date)),
            React.createElement('span', { className: 'bills-num' }, String(d.calls || 0)),
            React.createElement('span', { className: 'bills-num' }, fmtTokens(d.input)),
            React.createElement('span', { className: 'bills-num' }, fmtTokens(d.output)),
            React.createElement('span', { className: 'bills-num' }, fmtTokens(d.cacheRead)),
            React.createElement('span', { className: 'bills-num' }, fmtTokens(d.reasoning)),
            React.createElement('span', { className: 'bills-num' },
              React.createElement('div', null, fmtCost(d.cost)),
              React.createElement('div', { className: 'bills-cost-sub' }, '峰 ' + fmtCost(d.peakCost) + ' / 谷 ' + fmtCost(d.offPeakCost)))))
          body.push(React.createElement('tr', { key: s.sessionId + '-detail' },
            React.createElement('td', { colSpan: 8, className: 'bills-model-cell' },
              headerLine,
              lines,
            ),
          ))
        }
      }
      const empty = rows.length === 0
        ? React.createElement('div', { className: 'bills-empty' }, '窗口内暂无会话花费记录')
        : null
      return React.createElement('div', { className: 'bills-panel' },
        React.createElement('div', { className: 'bills-panel-head' },
          React.createElement('div', { className: 'bills-panel-title' }, '按会话统计 · 花费明细', props.range ? React.createElement('span', { className: 'bills-range' }, props.range) : null),
          React.createElement('span', { className: 'bills-window-range' }, '共 ' + rows.length + ' 个会话')),
        empty,
        empty ? null : React.createElement('div', { className: 'bills-table-wrap' },
          React.createElement('table', { className: 'bills-table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, '会话'),
                React.createElement('th', { className: 'bills-num' }, '调用'),
                React.createElement('th', { className: 'bills-num' }, '输入'),
                React.createElement('th', { className: 'bills-num' }, '输出'),
                React.createElement('th', { className: 'bills-num' }, '缓存读'),
                React.createElement('th', { className: 'bills-num' }, '推理'),
                React.createElement('th', { className: 'bills-num' }, '估算费用'),
                React.createElement('th', null, ''))),
            React.createElement('tbody', null, body))),
      )
    }

    // ---------- 常用数据汇总（窗口内） ----------
    function TopPanel(props) {
      const c = props.charts || {}
      const models = c.topModels || []
      const hours = c.topHours || []
      const busiest = c.busiest || null
      const left = React.createElement('div', { className: 'bills-mini' },
        React.createElement('div', { className: 'bills-mini-title' }, '窗口内常用模型 TOP ' + models.length),
        models.map((m) => React.createElement('div', { className: 'bills-mini-item', key: m.provider + '\u0000' + m.model },
          React.createElement('span', { className: 'bills-mini-key' },
            React.createElement('span', { className: 'bills-dot', style: { background: modelColor(m.provider, m.model) } }),
            m.model),
          React.createElement('span', { className: 'bills-mini-val' }, m.calls + ' 次 · ' + fmtCost(m.cost)))))
      const right = React.createElement('div', { className: 'bills-mini' },
        React.createElement('div', { className: 'bills-mini-title' }, '窗口内其他汇总'),
        React.createElement('div', { className: 'bills-mini-item' },
          React.createElement('span', { className: 'bills-mini-key' }, '最活跃时段'),
          React.createElement('span', { className: 'bills-mini-val' }, hours.length ? hours.map((h) => h.hour + ' 时（' + h.calls + ' 次）').join('、') : '—')),
        React.createElement('div', { className: 'bills-mini-item' },
          React.createElement('span', { className: 'bills-mini-key' }, '最活跃日期'),
          React.createElement('span', { className: 'bills-mini-val' }, busiest ? busiest.date + '（' + busiest.calls + ' 次）' : '—')),
        React.createElement('div', { className: 'bills-mini-item' },
          React.createElement('span', { className: 'bills-mini-key' }, '日均花费'),
          React.createElement('span', { className: 'bills-mini-val' }, (c.dayCount ? fmtCost(c.totalCost / c.dayCount) : '—') + ' / ' + (c.dayCount || 0) + ' 个活跃日')),
        React.createElement('div', { className: 'bills-mini-item' },
          React.createElement('span', { className: 'bills-mini-key' }, '总花费 / 总调用'),
          React.createElement('span', { className: 'bills-mini-val' }, fmtCost(c.totalCost) + ' / ' + (c.totalCalls || 0) + ' 次')))
      return React.createElement('div', { className: 'bills-panel' },
        React.createElement('div', { className: 'bills-panel-head' },
          React.createElement('div', { className: 'bills-panel-title' }, '常用数据汇总', props.range ? React.createElement('span', { className: 'bills-range' }, props.range) : null)),
        React.createElement('div', { className: 'bills-grid2' }, left, right))
    }

    function SkillsPanel(props) {
      const skills = props.skills || []
      const body = skills.length
        ? skills.map((s) => React.createElement('tr', { key: s.name },
          React.createElement('td', null, s.name),
          React.createElement('td', { className: 'bills-num' }, String(s.calls)),
          React.createElement('td', { className: 'bills-num' }, s.lastAt ? new Date(s.lastAt).toLocaleString() : '—')))
        : React.createElement('tr', null, React.createElement('td', { colSpan: 3 }, '暂无技能调用记录'))
      return React.createElement('div', { className: 'bills-panel' },
        React.createElement('div', { className: 'bills-panel-head' },
          React.createElement('div', { className: 'bills-panel-title' }, 'Skills 使用情况（全部历史）')),
        React.createElement('div', { className: 'bills-table-wrap' },
          React.createElement('table', { className: 'bills-table' },
            React.createElement('thead', null, React.createElement('tr', null,
              React.createElement('th', null, '技能'),
              React.createElement('th', { className: 'bills-num' }, '调用次数'),
              React.createElement('th', { className: 'bills-num' }, '最近调用'))),
            React.createElement('tbody', null, body))))
    }

    // 会话明细在窗口内的聚合（数据来自宿主按日折叠）
    function windowSession(s, start, end) {
      const r = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, peakCost: 0, offPeakCost: 0, days: [] }
      for (const d of s.days || []) {
        if (!inRange(d.date, start, end)) continue
        r.calls += d.calls || 0
        r.input += d.input || 0
        r.output += d.output || 0
        r.cacheRead += d.cacheRead || 0
        r.cacheWrite += d.cacheWrite || 0
        r.reasoning += d.reasoning || 0
        r.cost += d.cost || 0
        r.peakCost += d.peakCost || 0
        r.offPeakCost += d.offPeakCost || 0
        r.days.push(d)
      }
      return r
    }

    function BillsPage(props) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const [charts, setCharts] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [win, setWin] = React.useState(() => {
        const r = presetRange(7)
        return { preset: 7, start: r.start, end: r.end }
      })
      const apiGet = (path) => fetch(path).then((r) => r.json())
      const load = React.useCallback(() => {
        setState({ loading: true, data: null, error: null })
        Promise.all([apiGet('/api/dsh-bills/summary'), apiGet('/api/dsh-bills/charts'), apiGet('/api/dsh-bills/config')]).then(
          (rs) => { setState({ loading: false, data: rs[0], error: null }); setCharts(rs[1]); setCfg(rs[2]) },
          (e) => setState({ loading: false, data: null, error: (e && e.message) || String(e) }),
        )
      }, [])
      React.useEffect(load, [load])

      if (state.loading) {
        return React.createElement('div', { className: 'bills-page' },
          React.createElement('div', { className: 'bills-loading' }, '正在读取账单缓存…'))
      }
      if (state.error) {
        return React.createElement('div', { className: 'bills-page' },
          React.createElement('div', { className: 'bills-error' }, '加载失败：' + state.error),
          React.createElement('button', { className: 'bills-refresh', onClick: load }, '重试'))
      }
      const d = state.data
      if (!d || d.error) {
        return React.createElement('div', { className: 'bills-page' },
          React.createElement('div', { className: 'bills-error' }, '加载失败：' + ((d && d.error) || '未知错误')),
          React.createElement('button', { className: 'bills-refresh', onClick: load }, '重试'))
      }

      const genTime = new Date(d.generatedAt)
      const genText = isNaN(genTime.getTime()) ? '' : genTime.toLocaleString()
      const cacheTime = d.cachedAt ? new Date(d.cachedAt) : null
      const cacheText = cacheTime && !isNaN(cacheTime.getTime()) ? cacheTime.toLocaleString() : genText
      const metaText = d.cachedAt ? '缓存于 ' + cacheText + '（增量同步 · 实时更新）' : '生成于 ' + genText
      const rangeText = (win.start || '—') + ' ~ ' + (win.end || '—')

      // ---- 窗口内聚合（来自 /charts 的按日明细） ----
      const daily = charts ? (charts.daily || []).filter((x) => inRange(x.date, win.start, win.end)) : []
      const heat = charts ? (charts.heat || []).filter((x) => inRange(x.date, win.start, win.end)) : []
      const totals = { sessions: 0, calls: 0, peakCalls: 0, offPeakCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, peakCost: 0, offPeakCost: 0 }
      const modelAgg = new Map()
      const hourAgg = new Map()
      for (const day of daily) {
        for (const m of day.models || []) {
          totals.calls += m.calls || 0
          totals.peakCalls += m.peakCalls || 0
          totals.offPeakCalls += m.offPeakCalls || 0
          totals.input += m.input || 0
          totals.output += m.output || 0
          totals.cacheRead += m.cacheRead || 0
          totals.cacheWrite += m.cacheWrite || 0
          totals.reasoning += m.reasoning || 0
          totals.cost += m.cost || 0
          totals.peakCost += m.peakCost || 0
          totals.offPeakCost += m.offPeakCost || 0
          const mk = m.provider + '\u0000' + m.model
          let agg = modelAgg.get(mk)
          if (!agg) { agg = { provider: m.provider, model: m.model, calls: 0, cost: 0 }; modelAgg.set(mk, agg) }
          agg.calls += m.calls || 0
          agg.cost += m.cost || 0
        }
      }
      for (const c of heat) {
        const ha = hourAgg.get(c.hour) || { calls: 0, tokens: 0 }
        ha.calls += c.calls || 0
        ha.tokens += c.tokens || 0
        hourAgg.set(c.hour, ha)
      }
      // 会话数（窗口内有调用的会话）+ 明细表行
      const sessionRows = []
      for (const s of d.sessions) {
        const w = windowSession(s, win.start, win.end)
        if (w.calls <= 0) continue
        totals.sessions += 1
        sessionRows.push(Object.assign({ sessionId: s.sessionId, title: s.title, origin: s.origin }, w))
      }
      sessionRows.sort((a, b) => (b.cost - a.cost) || (b.calls - a.calls))

      const topModels = [...modelAgg.values()].sort((a, b) => b.calls - a.calls || b.cost - a.cost).slice(0, 5)
      const topHours = [...hourAgg.entries()].map(([hour, v]) => ({ hour, calls: v.calls, tokens: v.tokens })).sort((a, b) => b.calls - a.calls).slice(0, 3)
      const dayArr = daily.map((x) => ({ date: x.date, calls: x.models.reduce((s, m) => s + (m.calls || 0), 0), cost: x.total || 0 }))
      const busiest = dayArr.slice().sort((a, b) => b.calls - a.calls)[0] || null
      const dayCount = dayArr.length
      const winCharts = { topModels, topHours, busiest, dayCount, totalCost: totals.cost, totalCalls: totals.calls }

      const pricing = d.pricing || {}
      const dbg = d.cacheDebug || null
      const stats = (dbg && dbg.syncStats) || null

      const chartBlocks = charts
        ? [
          React.createElement(BarPanel, { key: 'bar', data: daily, range: rangeText }),
          React.createElement(HeatPanel, { key: 'heat', heat: heat, range: rangeText }),
          React.createElement(SessionsPanel, { key: 'sessions', rows: sessionRows, range: rangeText }),
          React.createElement(TopPanel, { key: 'top', charts: winCharts, range: rangeText }),
          React.createElement(SkillsPanel, { key: 'skills', skills: charts.skills || [] }),
        ]
        : React.createElement('div', { className: 'bills-loading' }, '正在读取图表缓存…')

      return React.createElement('div', { className: 'bills-page' },
        React.createElement('div', { className: 'bills-head' },
          React.createElement('div', null,
            React.createElement('div', { className: 'bills-title' }, '模型用量账单'),
            React.createElement('div', { className: 'bills-meta' }, metaText)),
          React.createElement('div', { className: 'bills-head-right' },
            React.createElement(WindowBar, { win: win, onWin: setWin }),
            React.createElement('button', { className: 'bills-refresh', onClick: load }, '刷新'))),
        React.createElement(CacheConfigRow, { key: 'cfg', cfg: cfg, pickDirectory: props.pickDirectory, onSaved: (info) => setCfg(info) }),
        React.createElement(CardsPanel, { totals: totals }),
        chartBlocks,
        React.createElement('div', { className: 'bills-foot' },
          '· 数据来自会话日志中每次模型调用的 token 用量（assistant/message 事件），并按调用时间逐次计价；上方阅览窗口对全部统计、图表与明细生效（默认近 7 天）。',
          React.createElement('br', null),
          '· 计价单位：人民币（CNY）。DeepSeek 按官方人民币价目表（api-docs.deepseek.com）；' + (pricing.exchangeNote || '其余模型按汇率折算。') + '。',
          React.createElement('br', null),
          '· ' + (pricing.peakLabel || '') + '；空闲时段价格为高峰的一半，峰谷定价于 ' + (pricing.effectiveLabel || '2026-08-16 16:00 UTC') + ' 生效，生效前的调用按官方旧价计费。',
          React.createElement('br', null),
          '· 费用为估算值（元/百万 tokens）：计费输入 = 输入（缓存未命中）+ 缓存写，缓存读按命中价单列。仅供参考，非实际账单。',
          React.createElement('br', null),
          '· 账单缓存：' + (dbg && dbg.cachePath ? dbg.cachePath : (d.cachePath || '$DSH_HOME/profiles/<profile>/.bills-cache.json')) + '；增量同步：启动基线 + 事件实时增量 + 60 秒轮询增量（历史会话不重读），打开本页直接读取缓存。',
          dbg && dbg.lastError ? React.createElement('br', null) : null,
          dbg && dbg.lastError ? '· 缓存写盘最近错误：' + dbg.lastError : null,
          stats ? React.createElement('br', null) : null,
          stats ? '· 缓存统计：会话 ' + stats.sessions + ' 个 · 全量基线 ' + stats.fullScans + ' 次 · 增量同步 ' + stats.incrementalSyncs + ' 次 · 已折叠事件 ' + stats.eventsFolded + ' 个 · 最近同步 ' + stats.syncMs + ' ms' : null,
          React.createElement('br', null),
          '· 仅统计有模型调用的会话' + (d.totals && d.totals.unknownCostSessions ? '；' + d.totals.unknownCostSessions + ' 个会话因模型无参考价未计入费用' : '') + '。'))
    }

    // ---------- 会话头部「账单」按钮：切换到账单标签页 ----------
    function BillsAction(props) {
      return React.createElement('button', {
        type: 'button',
        className: 'bills-header-btn',
        title: '在会话标签页中查看模型用量账单',
        onClick: () => { if (props.openBills) props.openBills() },
      }, '账单')
    }

    function injectStyles() {
      const tagId = 'dsh-bills/styles'
      if (document.getElementById(tagId)) return
      const tag = document.createElement('style')
      tag.id = tagId
      tag.textContent = '\n.bills-page { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary); font-size: 14px; }\n.bills-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }\n.bills-head-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }\n.bills-title { font-size: 16px; font-weight: 600; }\n.bills-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.bills-refresh { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 13px; }\n.bills-refresh:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.bills-windowbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }\n.bills-cachecfg-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n.bills-cachecfg-input { flex: 1; min-width: 260px; font-family: var(--dsw-alias-font-mono, monospace); }\n.bills-cachecfg-msg { font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.bills-windowbar-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.bills-window-range { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.bills-win-custom { display: inline-flex; align-items: center; gap: 6px; }\n.bills-win-sep { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.bills-win-date { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 2px 6px; font-size: 12px; color-scheme: light dark; }\n.bills-header-btn { display: inline-flex; align-items: center; background: transparent; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }\n.bills-header-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.bills-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }\n.bills-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; }\n.bills-card .k { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.bills-card .v { font-size: 18px; font-weight: 600; margin-top: 4px; }\n.bills-card .v.cost { color: var(--dsw-alias-brand-primary); }\n.bills-panel { position: relative; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px 14px; }\n.bills-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }\n.bills-panel-title { font-size: 14px; font-weight: 600; }\n.bills-range { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 8px; }\n.bills-days { display: flex; gap: 6px; }\n.bills-day-btn { background: transparent; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; }\n.bills-day-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.bills-day-btn.active { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }\n.bills-chart-wrap { display: flex; gap: 8px; }\n.bills-chart-y { position: relative; width: 56px; height: 180px; flex: none; }\n.bills-y-label { position: absolute; right: 4px; transform: translateY(50%); font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }\n.bills-chart-area { position: relative; flex: 1; height: 180px; border-bottom: 1px solid var(--dsw-alias-border-l1); min-width: 0; overflow: hidden; }\n.bills-gridline { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--dsw-alias-border-l1); }\n.bills-bars { position: absolute; left: 0; right: 0; top: 0; bottom: 0; display: flex; align-items: flex-end; gap: 4px; padding: 0 2px; }\n.bills-bar-col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; cursor: pointer; }\n.bills-bar { width: 14px; max-width: 65%; border-radius: 4px 4px 0 0; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; min-height: 2px; transition: filter 0.12s; }\n.bills-bar:hover { filter: brightness(1.12); }\n.bills-bar-seg { width: 100%; }\n.bills-bar-seg.hoverable { cursor: pointer; }\n.bills-bar-seg.hoverable:hover { filter: brightness(1.2); }\n.bills-bar-label { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 4px; white-space: nowrap; }\n.bills-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; }\n.bills-legend-item { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.bills-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; }\n.bills-tip { position: absolute; z-index: 30; pointer-events: none; white-space: nowrap; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 6px 10px; font-size: 12px; line-height: 1.55; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); }\n.bills-tip-title { font-weight: 600; margin-bottom: 2px; }\n.bills-tip-row { display: flex; gap: 14px; justify-content: space-between; }\n.bills-tip-row .b { color: var(--dsw-alias-label-secondary); }\n.bills-heat { display: grid; grid-template-columns: 56px repeat(24, 1fr); gap: 2px; }\n.bills-heat-hlabel { font-size: 10px; color: var(--dsw-alias-label-secondary); align-self: center; text-align: center; }\n.bills-heat-rowlabel { font-size: 10px; color: var(--dsw-alias-label-secondary); align-self: center; white-space: nowrap; overflow: hidden; }\n.bills-heat-cell { aspect-ratio: 1; border-radius: 2px; }\n.bills-heat-cell.hoverable { cursor: pointer; }\n.bills-heat-legend { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }\n.bills-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }\n.bills-mini-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }\n.bills-mini-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }\n.bills-mini-item:last-child { border-bottom: none; }\n.bills-mini-key { display: inline-flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.bills-mini-val { color: var(--dsw-alias-label-secondary); white-space: nowrap; }\n.bills-table-wrap { overflow-x: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }\n.bills-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 760px; }\n.bills-table th { text-align: left; color: var(--dsw-alias-label-secondary); font-weight: 500; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }\n.bills-table td { padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }\n.bills-table tr:last-child td { border-bottom: none; }\n.bills-table tbody tr.row-click { cursor: pointer; }\n.bills-table tbody tr.row-click:hover { background: var(--dsw-alias-bg-layer-2); }\n.bills-model-cell { padding: 0 12px 10px 12px !important; }\n.bills-model-line { display: grid; grid-template-columns: 1.6fr 0.6fr 0.8fr 0.8fr 0.8fr 0.9fr; gap: 8px; padding: 6px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 6px; }\n.bills-day-line { grid-template-columns: 1.1fr 0.5fr 0.7fr 0.7fr 0.7fr 0.7fr 0.9fr; }\n.bills-model-line .m { color: var(--dsw-alias-label-primary); }\n.bills-cost-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }\n.bills-badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); margin-left: 6px; vertical-align: middle; }\n.bills-empty { color: var(--dsw-alias-label-secondary); padding: 18px 0; text-align: center; font-size: 13px; }\n.bills-foot { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; }\n.bills-error { color: var(--dsw-alias-state-error-primary); }\n.bills-loading { color: var(--dsw-alias-label-secondary); padding: 24px 0; }\n.bills-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.bills-expand { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; user-select: none; }\n'
      document.head.appendChild(tag)
    }

    const inject = ['slots', 'workspaces']
    function apply(ctx) {
      injectStyles()
      // 账单视图标签页：与会话的 chat / trajectory 等标签并列，点击即整页阅览
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        {
          name: 'conversation.view', id: 'bills', order: 20, label: () => '账单',
          // 缓存目录选择：调用宿主原生文件夹选择器（workspaces.pickDirectory）
          inject: () => ({ pickDirectory: () => ctx.workspaces.pickDirectory() }),
        },
        (props) => React.createElement(BillsPage, props),
      ))
      // 会话头部「账单」按钮：一键切到账单标签页
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
        {
          name: 'conversation.session.header.actions', id: 'bills-open', order: 30,
          inject: (sessionId, actions) => ({
            openBills: () => { if (actions && actions.setView) actions.setView('bills') },
          }),
        },
        BillsAction,
      ))
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
