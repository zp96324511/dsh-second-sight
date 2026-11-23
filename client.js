/**
 * dsh-second-sight — Client half.
 *
 * 一个紧凑的「副眼」按钮，落在输入框工具行里、紧跟模型选择器之后
 * （`conversation.input.right` 座位的注释原文就是「Compact action after the
 * model selector」）。点开是一枚自绘 popover：
 *
 *   副眼 [开/关]
 *     ├ 副模型（按 provider 分组，只列真正声明了 image 的模型）
 *     └ 思考强度（该模型声明了几个就列几个，外加「默认」）
 *
 * 打开副眼会做两件事：先把选择写进 Host（`remote.secondSight.set`，按会话存），
 * 再把会话的模型切到 `<provider>-second-sight` 双胞胎路由。第二步不是可选项
 * ——会话控制器在附件准入时只看「当前模型声明没声明 image」，纯文本模型会在
 * 那一步直接拒收图片，双胞胎路由是唯一合法的逃逸口。切换后模型名不变（双胞胎
 * 的模型表照抄基座），所以界面上几乎看不出来。
 *
 * 面板弹窗（模型 / 推理等级）内部没有插槽，官方 ModelSelect 是私有渲染的，
 * 唯一不改写整个选择器的落点就是它右边这个 list 座位。
 */

window.__ModuleLoader__.load({
  id: 'dsh-second-sight',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PACKAGE = 'dsh-second-sight'
    const NAMESPACE = 'secondSight'
    /** 与 package.json 同步；scripts/check-manifest.mjs 会校验，避免面板显示旧版本号。 */
    const CLIENT_VERSION = '0.6.0'

    // —— 远端描述符 ——
    //
    // 网关注册时（`mount`/`validateContribution`）会逐参数跑 `requireStrictCodec`，
    // 只认 `mode: 'strict'`；`src-json` 会被拒（"has no strict codec"）。但 strict
    // 只要求 `typeSymbol` 非空 + `create()` 返回一个带 `.parse()` 的对象——宿主那边
    // 解析描述符时本来就把参数当 JSON 过，所以这里给一个"认得就过、不认得就放行"
    // 的最小解析器即可，不必拉 zod 进来（客户端半边零依赖）。

    const jsonCodec = (type, typeSymbol, jsonSchema, optional = false) => ({
      mode: 'strict',
      typeSymbol,
      jsonSchema,
      // 只做边界检查：类型相符就原样放行。真正的语义校验在 Host 的 ops 里。
      create: () => ({
        parse(value) {
          if (optional && (value === undefined || value === null)) return undefined
          if (type === 'text') {
            if (typeof value === 'string') return value
            throw new TypeError(`${typeSymbol} expects a string`)
          }
          if (value === undefined || value === null) return value
          if (typeof value !== 'object') throw new TypeError(`${typeSymbol} expects an object`)
          return value
        },
      }),
    })

    const textCodec = (typeSymbol, optional) => jsonCodec('text', typeSymbol, { type: 'string' }, optional)
    const objectCodec = (typeSymbol) => jsonCodec('object', typeSymbol, { type: 'object' })

    const jsonParam = (name, description, typeSymbol, acceptsUndefined = false) => ({
      name,
      description,
      source: 'json',
      wire: name,
      ...(acceptsUndefined ? { acceptsUndefined: true } : {}),
      codec: textCodec(typeSymbol, acceptsUndefined),
      strictCodec: textCodec(typeSymbol, acceptsUndefined),
    })

    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: [
        {
          id: `${PACKAGE}#${NAMESPACE}/state`,
          namespace: NAMESPACE,
          method: 'state',
          service: NAMESPACE,
          description:
            'Read this session’s vision fallback: whether the selected model accepts images, whether it is on a twin route, the chosen vision model (with its reasoning efforts) and every model that can serve as the vision fallback.',
          invocation: { kind: 'direct' },
          parameters: [
            jsonParam('sessionId', 'session whose composer asked', `${PACKAGE}#sessionId`),
            jsonParam('provider', 'provider id currently selected in the composer', `${PACKAGE}#provider`),
            jsonParam('model', 'model id currently selected in the composer', `${PACKAGE}#model`),
          ],
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#${NAMESPACE}/state:result`,
            create: () => objectCodec(`${PACKAGE}#${NAMESPACE}/state:result`).create(),
            jsonSchema: { type: 'object' },
            description: 'vision fallback state for one session',
          },
        },
        {
          id: `${PACKAGE}#${NAMESPACE}/set`,
          namespace: NAMESPACE,
          method: 'set',
          service: NAMESPACE,
          description:
            'Choose the vision fallback model for one session (optionally with its reasoning effort). Empty provider and model turn the fallback off and restore the configured default.',
          invocation: { kind: 'direct' },
          parameters: [
            jsonParam('sessionId', 'session to modify', `${PACKAGE}#sessionId`),
            jsonParam('provider', 'vision provider; empty clears the override', `${PACKAGE}#provider`, true),
            jsonParam('model', 'vision model; empty clears the override', `${PACKAGE}#model`, true),
            jsonParam('reasoningEffort', 'adapter-owned effort for the vision model; empty follows its default', `${PACKAGE}#effort`, true),
          ],
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#${NAMESPACE}/set:result`,
            create: () => objectCodec(`${PACKAGE}#${NAMESPACE}/set:result`).create(),
            jsonSchema: { type: 'object' },
            description: 'vision fallback state after the change',
          },
        },
      ],
    }

    // —— 文案 ——

    const DICT = {
      zh: {
        label: '副眼',
        heading: '副眼模型',
        title: '副眼 · 选一个识图模型',
        titleOn: '副眼 · 已开启，点击调整',
        hint: '当前模型不看图。选一个能看图的模型，附件会转交给它来读。',
        search: '搜索模型或 provider',
      noMatch: '没有匹配的模型。',
        native: '当前模型原生支持看图，不需要副眼。',
        noTwin: '这个 provider 没有副眼路由（被白名单或 excludeProviders 排除了）。',
        off: '关闭副眼',
        defaultEffort: '默认',
        effort: '思考强度：',
        loading: '读取中…',
        failed: '读取失败',
        updateCheck: '检查更新',
        updateChecking: '检查中…',
        updateAvailable: '有新版本',
        updateUpgrade: '一键升级',
        updateUpgrading: '升级中…',
        updateCurrent: '已是最新版本',
        updateUpgraded: '已升级，重启 dsh web 后生效',
        updateLocal: '本地安装，不提供在线升级',
        updateError: '检查更新失败',
        updateRetry: '重试',
        hostStale: '宿主仍在运行旧版插件（升级接口 404），重启 dsh web 后可用',
      },
      en: {
        label: 'Sight',
        heading: 'Sight model',
        title: 'Second sight — pick a vision model',
        titleOn: 'Second sight — on; click to adjust',
        hint: 'This model cannot see images. Pick a vision model and attachments are routed to it.',
        search: 'Search models or providers',
      noMatch: 'No matching model.',
        native: 'This model already accepts images; second sight is not needed.',
        noTwin: 'This provider has no twin route (excluded by the whitelist or excludeProviders).',
        off: 'Turn off',
        defaultEffort: 'Default',
        effort: 'Reasoning effort: ',
        loading: 'Loading…',
        failed: 'Unavailable',
        updateCheck: 'Check for updates',
        updateChecking: 'Checking…',
        updateAvailable: 'New version',
        updateUpgrade: 'Upgrade',
        updateUpgrading: 'Upgrading…',
        updateCurrent: 'Up to date',
        updateUpgraded: 'Upgraded — restart dsh web to apply',
        updateLocal: 'Local install — no online upgrade',
        updateError: 'Update check failed',
        updateRetry: 'Retry',
        hostStale: 'The host still runs the old plugin (update endpoint 404); restart dsh web',
      },
    }

    // —— 样式（跟随深色界面，变量不存在时用兜底色）——

    const text = (value) => (typeof value === 'string' ? value : '')
    const errorText = (error) => (error instanceof Error ? error.message : String(error ?? ''))

    /* ------------------------------------------------------------------ *
     * 升级通道（客户端）—— 面板底部那一行版本号 / 检查 / 一键升级。
     *
     * 宿主把路由挂在 `/plugins/dsh-second-sight`。这个页面可能被反向代理挂在
     * `/study-win10/` 这样的子路径下，所以先按 `document.baseURI` 拼，再退回根路径；
     * 成功一次之后记住那条前缀，别每个请求都试两遍。
     * ------------------------------------------------------------------ */

    const UPDATE_PREFIX = '/plugins/dsh-second-sight'
    const UPDATE_POLL_MS = 1200
    const UPDATE_POLL_LIMIT_MS = 20 * 60 * 1000
    let updateBase

    function updateCandidates() {
      const bases = []
      try {
        const root = new URL('.', document.baseURI || location.href).pathname.replace(/\/$/, '')
        bases.push(`${root}${UPDATE_PREFIX}`)
      } catch { /* 没有 document/location 的测试环境 */ }
      bases.push(UPDATE_PREFIX)
      return [...new Set(bases)]
    }

    async function updateRequest(path, { method = 'GET', body } = {}) {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this page')
      const bases = updateBase === undefined ? updateCandidates() : [updateBase]
      let lastFailure
      for (let index = 0; index < bases.length; index += 1) {
        const base = bases[index]
        const last = index === bases.length - 1
        try {
          const response = await fetch(`${base}${path}`, {
            method,
            cache: 'no-store',
            credentials: 'same-origin',
            headers: body === undefined
              ? { accept: 'application/json' }
              : { accept: 'application/json', 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          if (response.status === 404 && !last) {
            lastFailure = new Error('HTTP 404')
            lastFailure.status = 404
            continue
          }
          if (!response.ok) {
            const failure = new Error(`HTTP ${response.status}`)
            failure.status = response.status
            throw failure
          }
          const raw = await response.text()
          let parsed
          try {
            parsed = raw === '' ? {} : JSON.parse(raw)
          } catch {
            throw new Error(`unexpected response: ${raw.slice(0, 140)}`)
          }
          updateBase = base
          return parsed
        } catch (failure) {
          lastFailure = failure
          if (failure?.status === 404 && !last) continue
          throw failure
        }
      }
      throw lastFailure ?? new Error('update endpoint unavailable')
    }

    // 桌面端带上「副眼」二字，窄屏（手机）只留图标。
    // 桌面端带上「副眼」二字，窄屏（手机）只留图标。尺寸/圆角/字号都对齐官方模型触发器
    // （height 28 / radius-sm / label-secondary），看起来像同一排的原生控件。
    const triggerStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      height: 28,
      width: 28,
      padding: 0,
      border: 'none',
      outline: 'none',
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, rgba(236,236,239,0.72))',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flex: 'none',
    }

    const triggerWideStyle = {
      width: 'auto',
      padding: '0 8px 0 6px',
    }

    // 手机只留图标：不缩边距、不吃 gap，老老实实占自己那一格。
    const triggerNarrowStyle = {
      width: 24,
      height: 26,
      padding: 0,
    }

    // 开关只靠图标（睁眼/闭眼）+ 强调色区分，不画边框。
    const triggerOnStyle = {
      color: 'var(--dsw-alias-state-business-primary, #7d8bff)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #7d8bff) 14%, transparent)',
    }

    // 面板外壳：尺寸由测量写入（手机按视口夹住）；滚动交给内层列表，标题行因此不会被内容推走，
    // 也不需要 sticky（sticky 会让列表从标题背后滚过，像浮层）。
    const panelStyle = {
      position: 'fixed',
      zIndex: 2147483000,
      overflowY: 'hidden',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
      boxSizing: 'border-box',
      padding: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
      borderRadius: 10,
      background: 'var(--dsw-specific-menu, var(--dsw-menu-surface-fill, Canvas))',
      backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      boxShadow: 'var(--dsw-elevation-prominent, 0 3px 8px rgba(0,0,0,0.10), 0 0 20px rgba(0,0,0,0.06))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 12,
      lineHeight: 1.5,
    }

    // 标题、搜索框、关闭入口独占一行，占自己的高度：不是浮在列表上面的一层，
    // 所以背景沿用面板底色即可（无需实底），列表也永远不会从它背后穿过。
    // 搜索框占剩余宽度（flex 1），窄面板下自动收缩。
    const panelHeadStyle = {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flex: 'none',
      margin: '-6px -6px 0',
      padding: '8px 8px 6px',
      borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18))',
    }

    // 列表自己的滚动区：头部固定在上面，滚的只有这一块，滚到顶也不会露到标题行下面去。
    const panelBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      flex: '1 1 auto',
      minHeight: 0,
      margin: '0 0 -6px',
      padding: '2px 0 6px',
      overflowY: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
    }

    const panelTitleStyle = {
      flex: 'none',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }

    // 底部升级行：版本号、状态、一个按钮。日志展开时只占一小块，别把模型列表挤没。
    const panelFootStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      flex: 'none',
      margin: '0 -6px -6px',
      padding: '6px 8px 7px',
      // 用 inset 阴影画分隔线，而不是 borderTop：客户端测试靠 borderTop 认 provider 分组头。
      boxShadow: 'inset 0 1px 0 var(--dsw-alias-border-l2, rgba(128,128,128,0.18))',
    }

    const footRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
    }

    const versionStyle = {
      flex: 'none',
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.8))',
      whiteSpace: 'nowrap',
    }

    const footStatusStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.8))',
    }

    const footButtonStyle = {
      flex: 'none',
      padding: '2px 7px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      lineHeight: '16px',
      cursor: 'pointer',
    }

    const updateLogStyle = {
      margin: '2px 0 0',
      maxHeight: 84,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 10,
      lineHeight: 1.35,
      color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.8))',
    }

    // 还没有测量结果（首帧 / 测试环境）时的兜底位置。
    const FALLBACK_PANEL = { left: 12, bottom: 96, width: 300, maxHeight: 320 }

    /**
     * 面板落在哪：宽度按视口夹住，水平上夹在 [8, vw-width-8] 之间；
     * 高度只给「按钮上方真实剩余的空间」，否则手机上会顶出屏幕。
     * @param {{left:number, top:number}} rect - 触发按钮的视口矩形。
     * @param {{width:number, height:number}} viewport - 视口尺寸。
     * @returns {{left:number, bottom:number, width:number, maxHeight:number}} 用于 fixed 定位。
     */
    function panelRect(rect, viewport) {
      const vw = viewport?.width ?? 360
      const vh = viewport?.height ?? 640
      const top = rect?.top ?? 0
      const left = rect?.left ?? 0
      const width = Math.min(320, Math.max(200, vw - 16))
      const x = Math.min(Math.max(8, left), Math.max(8, vw - width - 8))
      return {
        left: x,
        bottom: Math.max(8, vh - top + 6),
        width,
        maxHeight: Math.max(140, Math.min(420, top - 14)),
      }
    }


    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      boxSizing: 'border-box',
      padding: '5px 8px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      textAlign: 'left',
      cursor: 'pointer',
    }

    // 分组头（provider 行）：明确的一行，上方带分隔线，别让它消失在模型列表里。
    const groupStyle = {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      flex: 'none',
      margin: '4px 0 0',
      padding: '6px 8px 3px',
      borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
      fontSize: 11,
      fontWeight: 500,
      lineHeight: '15px',
      color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.8))',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const searchStyle = {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      margin: '0 0 4px',
      padding: '5px 8px',
      border: 'none',
      outline: 'none',
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
    }

    // 档位是分段控件，不是主按钮：选中只提亮，不用品牌高亮抢戏。

    const mutedStyle = { color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.6))', fontSize: 12 }

    // 「思考强度：」一行：label + 原生 select，比一排按钮省地方，手机上也不换行。
    // 它属于上面那个模型，所以贴着上一行、和下面下一个模型拉开一点距离。
    const effortRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flex: 'none',
      width: '100%',
      boxSizing: 'border-box',
      padding: '4px 8px 10px',
    }

    const selectStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      boxSizing: 'border-box',
      padding: '4px 8px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      borderRadius: 'var(--dsw-radius-sm, 8px)',
      background: 'var(--dsw-specific-menu, var(--dsw-menu-surface-fill, Canvas))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
    }

    /** 睁眼 = 副眼开着；闭眼（加一道斜杠）= 关着。 */
    function EyeIcon({ size = 14, open = true }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M1.6 8s2.4-4.2 6.4-4.2S14.4 8 14.4 8s-2.4 4.2-6.4 4.2S1.6 8 1.6 8Z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
          opacity: open ? 1 : 0.55,
        }),
        h('circle', { cx: 8, cy: 8, r: 1.9, stroke: 'currentColor', strokeWidth: 1.4, opacity: open ? 1 : 0.55 }),
        open
          ? null
          : h('path', {
              d: 'M2.6 13.4 13.4 2.6',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
            }),
      )
    }

    /**
     * 按钮文字（桌面端）：开着副眼时显示「模型名 · 档位」，没选档位就只显示模型名；
     * 没开副眼时显示「副眼」。移动端只留图标，不走这里。
     */
    function effortLabel(vision) {
      if (vision?.reasoningEffort == null || vision.reasoningEffort === '') return ''
      const groups = Array.isArray(vision?.efforts) ? vision.efforts : []
      const found = groups.find((item) => item?.id === vision.reasoningEffort)
      return ` · ${found?.name ?? vision.reasoningEffort}`
    }

    const WIDE_QUERY = '(min-width: 641px)'

    /** 桌面端（宽屏）显示文字，手机只留图标。 */
    function useWide() {
      const subscribe = useCallback((notify) => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
        const query = window.matchMedia(WIDE_QUERY)
        if (typeof query.addEventListener === 'function') {
          query.addEventListener('change', notify)
          return () => query.removeEventListener('change', notify)
        }
        query.addListener(notify)
        return () => query.removeListener(notify)
      }, [])
      const snapshot = useCallback(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
        return window.matchMedia(WIDE_QUERY).matches
      }, [])
      return useSyncExternalStore(subscribe, snapshot)
    }

    // —— 组件 ——

    function VisionPill(props) {
      const { sessionId, store, directory, remote } = props
      const t = props.t
      const snapshot = useSyncExternalStore(
        useCallback((notify) => store.subscribe(notify), [store]),
        useCallback(() => store.getSnapshot(), [store]),
      )
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const buttonRef = useRef(null)
      const panelRef = useRef(null)

      // —— 底部升级行 ——
      const [update, setUpdate] = useState(undefined)
      const [updatePhase, setUpdatePhase] = useState('idle')
      const [updateError, setUpdateError] = useState(undefined)
      const [updateJob, setUpdateJob] = useState(undefined)
      const autoChecked = useRef(false)
      const pollTimer = useRef(null)

      const refreshUpdate = useCallback(async (force) => {
        if (typeof fetch !== 'function') return
        setUpdatePhase((phase) => (phase === 'upgrading' ? phase : 'checking'))
        setUpdateError(undefined)
        try {
          const info = await updateRequest(`/update${force ? '?force=1' : ''}`)
          if (typeof info?.current !== 'string') throw new Error('unexpected update payload')
          setUpdate(info)
          if (info.stale === true) {
            setUpdatePhase('upgraded')
          } else if (info.channel?.kind === 'local' || info.channel?.kind === 'git') {
            setUpdatePhase('unavailable')
          } else if (info.error !== undefined && info.hasUpdate !== true) {
            setUpdatePhase('error')
            setUpdateError(String(info.error))
          } else {
            setUpdatePhase(info.hasUpdate === true ? 'available' : 'current')
          }
        } catch (failure) {
          setUpdatePhase('error')
          setUpdateError(errorText(failure))
        }
      }, [])

      const pollUpdateJob = useCallback(() => {
        const deadline = Date.now() + UPDATE_POLL_LIMIT_MS
        const tick = async () => {
          try {
            const job = await updateRequest('/update/job')
            setUpdateJob(job)
            if (job?.state === 'running') {
              if (Date.now() > deadline) {
                setUpdatePhase('error')
                setUpdateError('the install did not finish in time')
                return
              }
              pollTimer.current = setTimeout(() => { void tick() }, UPDATE_POLL_MS)
              return
            }
            if (job?.state === 'done') {
              // 安装成功后磁盘上的 package.json 已经变成新版；内存里仍是旧模块，
              // 所以版本行显示「旧 → 新」，并明确要求重启 dsh web。
              setUpdate((previous) => ({
                ...(previous ?? {}),
                current: text(job.installed) || text(previous?.current),
              }))
              setUpdatePhase('upgraded')
              setUpdateError(job.error === undefined ? undefined : String(job.error))
              return
            }
            setUpdatePhase('error')
            setUpdateError(String(job?.error ?? 'the install stopped'))
          } catch (failure) {
            setUpdatePhase('error')
            setUpdateError(errorText(failure))
          }
        }
        void tick()
      }, [])

      const startUpgrade = useCallback(async () => {
        if (typeof fetch !== 'function') return
        setUpdatePhase('upgrading')
        setUpdateError(undefined)
        setUpdateJob(undefined)
        try {
          const result = await updateRequest('/update/upgrade', {
            method: 'POST',
            body: { version: update?.latest },
          })
          if (result?.ok !== true) {
            throw new Error(String(result?.error ?? result?.reason ?? 'upgrade refused'))
          }
          setUpdateJob(result.job)
          pollUpdateJob()
        } catch (failure) {
          setUpdatePhase('error')
          setUpdateError(errorText(failure))
        }
      }, [update, pollUpdateJob])

      // 打开面板自动静默检查一次；之后靠按钮手动检查，避免每次开合都打网络。
      useEffect(() => {
        if (!open || autoChecked.current) return
        autoChecked.current = true
        void refreshUpdate(false)
      }, [open, refreshUpdate])

      // 面板关掉 / 组件卸载：停掉轮询，别把定时器留在页面里。
      useEffect(() => () => {
        if (pollTimer.current !== null) {
          clearTimeout(pollTimer.current)
          pollTimer.current = null
        }
      }, [])

      const provider = text(snapshot.current?.provider)
      const model = text(snapshot.current?.model)
      const effort = text(snapshot.current?.reasoningEffort)

      const refresh = useCallback(
        async (nextProvider, nextModel) => {
          if (remote === undefined) return
          try {
            const reply = await remote.state(String(sessionId), nextProvider, nextModel)
            if (reply === undefined || reply === null || reply.ok !== true) {
              throw reply?.error ?? new Error('remote.secondSight.state failed')
            }
            setState(reply.value)
            setError(undefined)
          } catch (failure) {
            setError(errorText(failure))
          }
        },
        [remote, sessionId],
      )

      useEffect(() => {
        if (directory !== undefined) void Promise.resolve(directory.load()).catch(() => {})
      }, [directory])

      useEffect(() => {
        if (provider === '' || model === '') return
        void refresh(provider, model)
      }, [provider, model, refresh])

      // 开着副眼却在普通 provider 上（用户刚在模型列表里换了模型）：
      // 自动切回它的双胞胎，否则附件会被闸 1 拒收。
      // 但主模型换成多模态时不该切回去——那种模型自己就能看图，见下面那段自动关闭。
      const lastHeal = useRef('')
      useEffect(() => {
        if (state === undefined || state === null || directory === undefined) return
        if (state.onTwin || state.vision === null || state.vision === undefined) return
        if (state.textOnly === false) return
        if (state.twin === null) return
        if (provider === '' || model === '') return
        if (provider === state.twin) return
        const signature = `${state.twin}/${model}/${effort}`
        if (lastHeal.current === signature) return
        lastHeal.current = signature
        const selection = { provider: state.twin, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
        void Promise.resolve(directory.select(selection)).catch(() => {})
      }, [state, provider, model, effort, directory])

      // 会话停在双胞胎上、当前模型却是多模态：provider 也得退回基座。
      // 只在 Host 侧清覆盖是不够的——那样会话会永远挂在 `xxx + 副眼` 这个 provider
      // 上（菜单里也只有它的行），用户看到的「切回基座」就不会发生。
      const lastFallback = useRef('')
      useEffect(() => {
        if (state === undefined || state === null || directory === undefined) return
        if (!state.onTwin) return
        if (state.textOnly !== false) return
        if (typeof state.base !== 'string' || state.base === '') return
        if (model === '') return
        const signature = `${state.base}/${model}/${effort}`
        if (lastFallback.current === signature) return
        lastFallback.current = signature
        const selection = { provider: state.base, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
        void Promise.resolve(directory.select(selection)).catch(() => {})
      }, [state, model, effort, directory])

      // 副眼开着、主模型却是多模态：多模态自己就能看图，副眼没有意义了。
      // 清 Host 里的会话覆盖；provider 的回退由上面那段负责。
      const lastAutoOff = useRef('')
      useEffect(() => {
        if (state === undefined || state === null || remote === undefined) return
        if (state.vision === null || state.vision === undefined) return
        if (state.textOnly !== false) return
        if (provider === '' || model === '') return
        const signature = `${provider}/${model}`
        if (lastAutoOff.current === signature) return
        lastAutoOff.current = signature
        void (async () => {
          try {
            const reply = await remote.set(String(sessionId), '', '', '')
            if (reply !== undefined && reply !== null && reply.ok === true) setState(reply.value)
            else setError(errorText(reply?.error ?? new Error('remote.secondSight.set failed')))
          } catch (failure) {
            setError(errorText(failure))
          }
        })()
      }, [state, provider, model, remote, sessionId])

      // 点击外面 / 按 Esc 关掉
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const applyOverride = useCallback(
        async (nextProvider, nextModel, nextEffort) => {
          const twin = state?.twin
          if (twin === null || twin === undefined) return
          setBusy(true)
          try {
            const reply = await remote.set(String(sessionId), nextProvider, nextModel, text(nextEffort))
            if (reply === undefined || reply === null || reply.ok !== true) {
              throw reply?.error ?? new Error('remote.secondSight.set failed')
            }
            // 注意：这里切的是「会话自己的模型」，不是副模型——双胞胎路由只是让图片能进来，
            // 真正干活的仍是主模型；副模型只存在 Host 的会话覆盖里，由 ask_image 用。
            const selection = { provider: twin, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
            const outcome = await directory.select(selection)
            if (outcome !== undefined && outcome !== null && outcome.ok === false) {
              throw outcome.error ?? new Error('model selection failed')
            }
            setState(reply.value)
            setError(undefined)
            // 面板留着：选完模型紧接着就能调这个模型的思考强度。
          } catch (failure) {
            setError(errorText(failure))
          } finally {
            setBusy(false)
          }
        },
        [remote, sessionId, state, directory, model, effort],
      )

      const turnOff = useCallback(async () => {
        if (state === undefined) return
        setBusy(true)
        try {
          const reply = await remote.set(String(sessionId), '', '', '')
          if (reply === undefined || reply === null || reply.ok !== true) {
            throw reply?.error ?? new Error('remote.secondSight.set failed')
          }
          const selection = {
            provider: state.base,
            model,
            ...(effort === '' ? {} : { reasoningEffort: effort }),
          }
          const outcome = await directory.select(selection)
          if (outcome !== undefined && outcome !== null && outcome.ok === false) {
            throw outcome.error ?? new Error('model selection failed')
          }
          setState(reply.value)
          setError(undefined)
          setOpen(false)
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setBusy(false)
        }
      }, [remote, sessionId, state, directory, model, effort])

      // 所有 hook 必须在这几个 return 之前：条件调用 hook 会让 React 抛错、
      // 整枚座位（连同输入工具行那一段）都渲染不出来。
      const wide = useWide()

      // 面板贴着按钮往上弹：宽度按视口夹住，高度按按钮上方的真实空间夹住，
      // 否则手机上会顶出屏幕（外层是 fixed + overflow hidden，内容再长也只会内部滚动）。
      const [anchor, setAnchor] = useState(undefined)
      const [query, setQuery] = useState('')
      useEffect(() => {
        if (!open) {
          setAnchor(undefined)
          return undefined
        }
        const measure = () => {
          const node = buttonRef.current
          const rect = typeof node?.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : undefined
          if (typeof window === 'undefined' || rect === undefined || rect === null) {
            setAnchor(FALLBACK_PANEL)
            return
          }
          setAnchor(panelRect(rect, { width: window.innerWidth || 360, height: window.innerHeight || 640 }))
        }
        measure()
        // 测试环境与某些内嵌视图里没有 window 事件，测量一次就够。
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const viewport = window.visualViewport
        window.addEventListener('resize', measure)
        viewport?.addEventListener('resize', measure)
        viewport?.addEventListener('scroll', measure)
        document?.addEventListener?.('scroll', measure, true)
        return () => {
          window.removeEventListener?.('resize', measure)
          viewport?.removeEventListener?.('resize', measure)
          viewport?.removeEventListener?.('scroll', measure)
          document?.removeEventListener?.('scroll', measure, true)
        }
      }, [open])

      // 原生多模态、没有双胞胎、还没读到状态 —— 都不占位置。
      // 例外：副眼已经开着、provider 也还有双胞胎路由，但这会儿会话落在原生多模态模型上
      // （例如在模型列表里手动换过去）。此时这个小按钮是唯一能关掉/重选副眼的入口，必须留着。
      if (directory === undefined || remote === undefined) return null
      if (state === undefined) return null
      const visionOn = state.vision !== null && state.vision !== undefined
      const hasTwin = state.twin !== null && state.twin !== undefined
      // 主模型是多模态：它自己就能看图，副眼没有意义，按钮一律不出现。
      if (state.textOnly === false) return null
      if (!state.onTwin && !hasTwin) return null

      // 图标按钮：睁眼/闭眼表示开关，窄屏只留图标。
      const on = visionOn

      // —— 底部升级行文案 ——
      // loaded 是「正在运行的模块」的版本，current 是「磁盘上的文件」的版本；
      // 一键升级完成后两者会不同，正好用「旧 → 新」提示重启。
      const loadedVersion = text(update?.loaded) || text(update?.current) || CLIENT_VERSION
      const diskVersion = text(update?.current)
      const versionLabel = diskVersion !== '' && diskVersion !== loadedVersion
        ? `${loadedVersion} → ${diskVersion}`
        : loadedVersion
      const installedVersion = text(updateJob?.installed)
      let updateStatus = ''
      let updateAction = t('updateCheck')
      let updateDisabled = false
      switch (updatePhase) {
        case 'checking':
          updateStatus = t('updateChecking')
          updateAction = t('updateChecking')
          updateDisabled = true
          break
        case 'available':
          updateStatus = `${t('updateAvailable')} v${text(update?.latest)}`
          updateAction = t('updateUpgrade')
          break
        case 'upgrading':
          updateStatus = t('updateUpgrading')
          updateAction = t('updateUpgrading')
          updateDisabled = true
          break
        case 'upgraded':
          updateStatus = `${t('updateUpgraded')}${installedVersion === '' ? '' : `（v${installedVersion}）`}`
          updateAction = ''
          updateDisabled = true
          break
        case 'current':
          updateStatus = t('updateCurrent')
          break
        case 'unavailable':
          updateStatus = t('updateLocal')
          break
        case 'error':
          updateStatus = updateError !== undefined && updateError.includes('404')
            ? t('hostStale')
            : `${t('updateError')}${updateError === undefined ? '' : `：${updateError}`}`
          updateAction = t('updateRetry')
          break
        default:
          updateStatus = ''
          updateAction = t('updateCheck')
      }

      const groups = Array.isArray(state.options) ? state.options : []
      const selectedProvider = state.vision?.provider
      const selectedModel = state.vision?.model

      // 搜索：provider 名/ID 命中就保留整组，否则按模型名/ID 过滤；provider 分行为准。
      const needle = query.trim().toLowerCase()
      const match = (value) => String(value ?? '').toLowerCase().includes(needle)
      const visibleGroups = needle === ''
        ? groups
        : groups
            .map((group) => (match(group.name) || match(group.provider)
              ? group
              : { ...group, models: group.models.filter((model) => match(model.name) || match(model.id)) }))
            .filter((group) => (match(group.name) || match(group.provider) ? true : group.models.length > 0))

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            title: on ? t('titleOn') : t('title'),
            'aria-label': on ? t('titleOn') : t('title'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => {
              const next = !open
              setOpen(next)
              if (!next) setQuery('')
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.background = on
                ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #7d8bff) 20%, transparent)'
                : 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))'
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = on
                ? triggerOnStyle.background
                : 'transparent'
            },
            style: { ...triggerStyle, ...(wide ? triggerWideStyle : triggerNarrowStyle), ...(on ? triggerOnStyle : null) },
          },
          h(EyeIcon, { size: wide ? 15 : 16, open: on }),
          wide
            ? h(
                'span',
                { style: { lineHeight: 1, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                on && state.vision?.modelName ? `${state.vision.modelName}${effortLabel(state.vision)}` : t('label'),
              )
            : null,
        ),
        open
          ? createPortal(
              h(
                'div',
                { ref: panelRef, role: 'dialog', 'aria-label': t('title'), style: { ...panelStyle, ...(anchor ?? FALLBACK_PANEL) } },
                h(
                  'div',
                  { style: panelHeadStyle },
                  h('div', { style: panelTitleStyle }, t('heading')),
                  h('input', {
                    type: 'search',
                    value: query,
                    placeholder: t('search'),
                    'aria-label': t('search'),
                    onChange: (event) => setQuery(event.target.value),
                    // 占满标题与关闭入口之间的剩余宽度；minWidth 0 允许窄面板继续收缩
                    style: { ...searchStyle, flex: '1 1 80px', width: 'auto', minWidth: 0, margin: 0 },
                  }),
                  on
                    ? h(
                        'button',
                        {
                          type: 'button',
                          disabled: busy,
                          onClick: () => void turnOff(),
                          style: {
                            ...rowStyle,
                            width: 'auto',
                            flex: 'none',
                            padding: '2px 6px',
                            whiteSpace: 'nowrap',
                            ...mutedStyle,
                            cursor: 'pointer',
                          },
                        },
                        t('off'),
                      )
                    : null,
                ),
                h(
                  'div',
                  { style: panelBodyStyle },
                  state.textOnly ? null : h('div', { style: { ...mutedStyle, padding: '0 8px 8px' } }, t('native')),
                state.twin === null
                  ? h('div', { style: { ...mutedStyle, padding: '0 8px 8px' } }, t('noTwin'))
                  : visibleGroups.length === 0 && needle !== ''
                    ? h('div', { style: { ...mutedStyle, padding: '6px 8px' } }, t('noMatch'))
                    : visibleGroups.map((group) =>
                      h(
                        React.Fragment,
                        { key: group.provider },
                        h('div', { style: groupStyle }, group.name ?? group.provider),
                        group.models.map((candidate) => {
                          const active = on && group.provider === selectedProvider && candidate.id === selectedModel
                          const efforts = Array.isArray(candidate.efforts) ? candidate.efforts : []
                          return h(
                            React.Fragment,
                            { key: candidate.id },
                            h(
                              'button',
                              {
                                type: 'button',
                                disabled: busy || state.twin === null,
                                onClick: () => {
                                  // 再点一次已选中的模型 = 关掉副眼（和「关闭副眼」按钮等价）。
                                  if (active) {
                                    void turnOff()
                                    return
                                  }
                                  void applyOverride(group.provider, candidate.id, state.vision?.reasoningEffort ?? '')
                                },
                                style: {
                                  ...rowStyle,
                                  background: active
                                    ? 'var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18)))'
                                    : 'transparent',
                                  opacity: state.twin === null ? 0.5 : 1,
                                },
                              },
                              h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, candidate.name ?? candidate.id),
                              active ? h('span', { style: { ...mutedStyle, fontSize: 12 } }, '✓') : null,
                            ),
                            active && efforts.length > 0
                              ? h(
                                  'div',
                                  { style: effortRowStyle },
                                  h('span', { style: mutedStyle }, t('effort')),
                                  h(
                                    'select',
                                    {
                                      disabled: busy,
                                      value: text(state.vision?.reasoningEffort),
                                      onChange: (event) =>
                                        void applyOverride(group.provider, candidate.id, event.target.value),
                                      style: selectStyle,
                                    },
                                    h('option', { value: '' }, t('defaultEffort')),
                                    efforts.map((item) =>
                                      h('option', { key: item.id, value: item.id }, item.name ?? item.id),
                                    ),
                                  ),
                                )
                              : null,
                          )
                        }),
                      ),
                    ),
                error === undefined
                  ? null
                  : h('div', { style: { ...mutedStyle, padding: '6px 8px 2px', color: 'var(--dsw-alias-state-error-primary, #f0666f)' } }, `${t('failed')}: ${error}`),
                busy ? h('div', { style: { ...mutedStyle, padding: '6px 8px 0' } }, t('loading')) : null,
                ),
                h(
                  'div',
                  { style: panelFootStyle },
                  h(
                    'div',
                    { style: footRowStyle },
                    h('span', { style: versionStyle, title: `dsh-second-sight v${versionLabel}` }, `v${versionLabel}`),
                    h('span', { style: footStatusStyle, title: updateStatus }, updateStatus),
                    updateAction === ''
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            disabled: updateDisabled,
                            onClick: () => {
                              if (updatePhase === 'available') void startUpgrade()
                              else void refreshUpdate(true)
                            },
                            style: {
                              ...footButtonStyle,
                              opacity: updateDisabled ? 0.55 : 1,
                              cursor: updateDisabled ? 'default' : 'pointer',
                            },
                          },
                          updateAction,
                        ),
                  ),
                  updateJob?.log
                    ? h('pre', { style: updateLogStyle }, updateJob.log.slice(-2000))
                    : null,
                ),
              ),
              document.body,
            )
          : null,
      )
    }


    const SUFFIX = '-second-sight'
    // 原型/原型链上的标记：重复 apply 时不重复打补丁。
    const PICKER_PATCHED = Symbol.for('dsh-second-sight.picker-patched')

    /**
     * 模型列表里每个 provider 只留一行：
     *   - 会话在双胞胎上 → 只留**当前**那一条「xxx + 副眼」，同名基座和其它 provider
     *     的双胞胎组都不显示（0.5.0 起双胞胎目录与基座一致，多显示一行纯属重复）；
     *   - 否则 → 隐藏所有双胞胎组，只留原始 provider（这时用户还能点别的 provider，
     *     选中后若副眼开着，座位会把会话自动切到那个 provider 的双胞胎）。
     * 当前选择的那一组永远保留，否则官方选择器会退化成「请选择模型」。
     */
    function oneRowPerProvider(snapshot) {
      const all = Array.isArray(snapshot?.groups) ? snapshot.groups : []
      const provider = typeof snapshot?.current?.provider === 'string' ? snapshot.current.provider : ''
      const onTwin = provider.endsWith(SUFFIX)
      const base = onTwin ? provider.slice(0, provider.length - SUFFIX.length) : provider
      const groups = all.filter((group) => {
        const id = typeof group?.id === 'string' ? group.id : ''
        if (id.endsWith(SUFFIX)) return onTwin && id === provider
        return !(onTwin && id === base)
      })
      return groups.length === all.length ? snapshot : { ...snapshot, groups }
    }

    /**
     * 给官方模型选择器装一层「每 provider 一行」的视图。
     *
     * 为什么打**原型**而不是实例：模型选择器在 apply 之前就可能把 `directory.store`
     * 缓存在座位注入结果里（我们 apply 开头还要 await $mount），实例级补丁追不上。
     * 而且 `ctx.modelDirectories` 拿到的是 cordis 的 service proxy，不同 ctx 的 proxy
     * 不是同一个对象；原型是唯一的公共面。
     *
     * 为什么还要就地改 `store.getSnapshot`：座位可能已经把 store 引用抓走了，
     * 这时候连原型补丁也来不及——但 store 是同一个对象，就地换方法对它同样生效。
     */
    function filterPicker(models) {
      if (models === undefined || models === null || typeof models.directoryFor !== 'function') {
        return () => {}
      }

      const proto = Object.getPrototypeOf(models)
      const holder = proto !== null && typeof proto.directoryFor === 'function' ? proto : models
      if (holder[PICKER_PATCHED] === true) return () => {}
      const original = holder.directoryFor
      const hadOwn = Object.prototype.hasOwnProperty.call(holder, 'directoryFor')
      const patchedStores = new WeakSet()
      const restores = []

      const patchStore = (store) => {
        if (store === undefined || store === null) return
        if (typeof store.getSnapshot !== 'function' || patchedStores.has(store)) return
        patchedStores.add(store)
        const raw = store.getSnapshot
        const memo = new WeakMap()
        store.getSnapshot = function snapshotOneRow() {
          const value = raw.call(this)
          let filtered = memo.get(value)
          if (filtered === undefined) {
            filtered = oneRowPerProvider(value)
            memo.set(value, filtered)
          }
          return filtered
        }
        restores.push(() => {
          if (store.getSnapshot !== undefined) store.getSnapshot = raw
        })
      }

      const replacement = function directoryForOneRow(sessionId) {
        const directory = original.call(this, sessionId)
        if (directory !== undefined && directory !== null) patchStore(directory.store)
        return directory
      }

      try {
        holder.directoryFor = replacement
        holder[PICKER_PATCHED] = true
        // 排障用：控制台敲 __secondSightPicker 能看到过滤装没装上。
        globalThis.__secondSightPicker = 'filtered'
      } catch {
        return () => {}
      }

      return () => {
        try {
          if (holder.directoryFor === replacement) {
            // 打的是原型就删掉自建属性；打的是实例自己的属性就还原回去。
            if (hadOwn) holder.directoryFor = original
            else delete holder.directoryFor
          }
          delete holder[PICKER_PATCHED]
          for (const restore of restores.splice(0)) {
            try {
              restore()
            } catch {
              /* 忽略 */
            }
          }
        } catch {
          /* 宿主已销毁，忽略 */
        }
      }
    }
    return {
      // 静态 inject 里不要写 remote.secondSight：这个插件自己 $mount 出这个命名空间，
      // 写进去会死等（apply 不跑 → 服务不出现 → inject 永不满足）。
      inject: ['slots', 'modelDirectories', 'locale', 'remote'],
      // 纯函数，导出给单测：面板在窄屏/软键盘下不许顶出屏幕。
      panelRect,
      async apply(ctx) {
        // 模型列表过滤要**先装**：下面的 $mount 是异步的，等它回来时输入框可能
        // 已经渲染过一轮，座位注入结果里已经把原始 store 抓走了。
        let unfilter = () => {}
        try {
          unfilter = filterPicker(ctx.modelDirectories)
        } catch (failure) {
          console.warn('[dsh-second-sight] 模型列表过滤没装上（不影响识图）:', failure)
        }

        let unmount = () => {}
        try {
          unmount = await ctx.remote.$mount(CONTRIBUTION)
        } catch (failure) {
          console.warn(`[dsh-second-sight] 无法挂载 remote.${NAMESPACE}:`, failure)
        }
        // $mount 之后命名空间服务就位；万一晚一拍，坐下一次渲染时再取一次。
        let remote = ctx.get(`remote.${NAMESPACE}`)
        const remoteOf = () => {
          if (remote === undefined) {
            try {
              remote = ctx.get(`remote.${NAMESPACE}`)
            } catch {
              remote = undefined
            }
          }
          return remote
        }

        let t = (key) => DICT.zh[key] ?? key
        try {
          ctx.locale.register(NAMESPACE, 'zh', DICT.zh)
          ctx.locale.register(NAMESPACE, 'en', DICT.en)
          const bound = ctx.locale.bind(NAMESPACE)
          if (typeof bound === 'function') t = bound
        } catch {
          /* 语言服务不可用就用中文兜底 */
        }

        const models = ctx.modelDirectories

        // 座位组件：`conversation.input.right` 是 session 级 list 槽，框架会把
        // 当前会话的 sessionId 作为 prop 传进来（官方模型座位的用法一致）。
        // 目录/远端都从闭包拿，不依赖这枚座位是否支持 inject 面。
        function SecondSightSeat(props) {
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
          if (sessionId === undefined) return null
          let directory
          try {
            directory = models.directoryFor(sessionId)
          } catch {
            directory = undefined
          }
          return h(VisionPill, {
            key: sessionId,
            sessionId,
            directory,
            store: directory?.store,
            remote: remoteOf(),
            t,
          })
        }

        ctx.slots.inject('conversation.input.right', () => {
          return ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'second-sight',
              order: 10,
            },
            SecondSightSeat,
          )
        })

        return async () => {
          unfilter()
          await unmount()
        }
      },
    }
  },
})