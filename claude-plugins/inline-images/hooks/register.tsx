import type { EngineInterface, Register } from 'claude-code'

// Pictures inline in the terminal (kitty graphics in kitty, Ghostty and Herdr):
// a thumbnail under every Read of an image file, and a `show_image` tool the
// model calls to put a picture in front of the person. Clicking a thumbnail (or
// its zoom button, or `/view-image <path>`) opens the full picture in Herdr's
// image-viewer dialog, which zooms and pans on the GPU; outside Herdr, in imv.

const TOOL = 'show_image'
const SHOW = `mcp__inline-images__${TOOL}`
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic|heif)$/i
const CACHE = '/tmp/claude-inline-images'
// Image takes at most 2 MiB of PNG: try smaller until one fits.
const MAX_BYTES = 2 * 1024 * 1024
const EDGES = [1600, 1100, 720]
// Only the ratio matters: a terminal cell is about twice as tall as wide.
const CELL_W = 10
const CELL_H = 21
const MAX_ROWS = 22
// The viewer gets the picture this big at most: enough to zoom into a screenshot.
const VIEW_EDGE = 6000

type Pic = { png: string; width: number; height: number }

// Converted pictures by tool_use_id; a reload starts it empty and reconverts.
const pics = new Map<string, Promise<Pic | null>>()

const base = (path: string) => path.split('/').pop() ?? path
const slug = (s: string) => s.replace(/[^\w-]/g, '_').slice(-120)

async function size($: EngineInterface, file: string) {
  const r = await $.process.run(['magick', 'identify', '-format', '%w %h', file])
  const [width, height] = r.stdout.trim().split(' ').map(Number)
  return width && height ? { width, height } : null
}

// Any image magick reads, as a PNG small enough for Image.
async function convert($: EngineInterface, path: string, id: string): Promise<Pic | null> {
  await $.process.run(['mkdir', '-p', CACHE])
  for (const edge of EDGES) {
    const out = `${CACHE}/${slug(id)}-${edge}.png`
    if (!(await $.fs.exists(out))) {
      const made = await $.process.run(
        ['magick', `${path}[0]`, '-auto-orient', '-resize', `${edge}x${edge}>`, '-strip', out],
        { timeoutMs: 20000 },
      )
      if (made.exitCode !== 0) return null
    }
    const dims = await size($, out)
    if (!dims) return null
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    if ((base64.length * 3) / 4 <= MAX_BYTES) return { png: base64, ...dims }
  }
  return null
}

function picFor($: EngineInterface, id: string, path: string): Promise<Pic | null> {
  let pic = pics.get(id)
  if (!pic) {
    pic = convert($, path, id).catch(() => null)
    pics.set(id, pic)
  }
  return pic
}

// The thumbnail's box in cells: natural size, no wider than the room, no taller than MAX_ROWS.
function cells(pic: Pic, room: number) {
  let columns = Math.min(Math.ceil(pic.width / CELL_W), room, 255)
  let rows = Math.round((columns * CELL_W * pic.height) / pic.width / CELL_H)
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.round((rows * CELL_H * pic.width) / pic.height / CELL_W)
  }
  return { columns: Math.max(1, Math.min(columns, 255)), rows: Math.max(1, Math.min(rows, 255)) }
}

// Herdr's viewer reads pictures from its own home (image() resolves there): put a
// PNG copy in data/image-viewer, write the request beside it, and open the viewer.
async function openInHerdr($: EngineInterface, path: string): Promise<boolean> {
  const inHerdr = (await $.process.run(['printenv', 'HC_TERMINAL_ID'])).stdout.trim() !== ''
  if (!inHerdr) return false
  const home = (await $.process.run(['sh', '-c', 'printf %s "${HERDR_APP_HOME:-$HOME/.config/herdr-app}"'])).stdout
  const dir = `${home}/data/image-viewer`
  // Keep the last few copies: the dialog may still show one.
  await $.process.run(['sh', '-c', 'mkdir -p "$1" && cd "$1" && ls -t v-*.png 2>/dev/null | tail -n +6 | xargs -r rm -f', 'sh', dir])
  const name = `v-${Math.round(await $.clock.now())}.png`
  const made = await $.process.run(
    ['magick', `${path}[0]`, '-auto-orient', '-resize', `${VIEW_EDGE}x${VIEW_EDGE}>`, '-strip', `${dir}/${name}`],
    { timeoutMs: 30000 },
  )
  if (made.exitCode !== 0) return false
  const dims = await size($, `${dir}/${name}`)
  if (!dims) return false
  await $.fs.write(`${dir}/request.json`, JSON.stringify({ file: `data/image-viewer/${name}`, ...dims, name: base(path) }))
  const opened = await $.process.run(['herdr-app', 'do', 'mod.open', '--name', 'image-viewer'])
  return opened.exitCode === 0 && !opened.stdout.includes('"error"')
}

async function openViewer($: EngineInterface, path: string) {
  if (await openInHerdr($, path).catch(() => false)) return
  // Not in Herdr (or it refused): a desktop viewer, detached from this session.
  const viewer = (await $.process.run(['sh', '-c', 'command -v imv || command -v xdg-open'])).stdout.trim()
  if (viewer) await $.process.run(['setsid', '-f', viewer, path])
  else $.ui.toast(`No image viewer found for ${base(path)}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      description:
        'Show an image file to the user inline in their terminal (a screenshot, chart, diagram, design, photo). ' +
        'Use it whenever the user would want to see a picture you made, found or are talking about. ' +
        'PNG, JPEG, GIF, WebP and other common formats. The image is shown to the user only; Read it to look at it yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the image file' },
          caption: { type: 'string', description: 'Optional short caption shown under the image' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'view-image', description: 'Open an image in the zoomable viewer', argumentHint: '<path>' })
    return started
  })

  on('command.run', { command: 'view-image' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) return { text: 'Usage: /view-image <path to an image>' }
    const path = (await $.fs.stat(arg, { resolve: true }).catch(() => undefined))?.realPath
    if (!path) return { text: `No such file: ${arg}` }
    await openViewer($, path)
    return { text: `Opened ${base(path)} in the image viewer.` }
  })

  on('tool.call', { tool: SHOW }, async ($, e) => {
    const input = e as unknown as { tool_use_id: string; path?: string; caption?: string }
    const path = input.path ?? ''
    if (!path.startsWith('/')) return { deny: 'path must be an absolute path to an image file' }
    if (!(await $.fs.exists(path))) return { deny: `no such file: ${path}` }
    const pic = await picFor($, input.tool_use_id, path)
    if (!pic) return { deny: `could not read ${path} as an image` }
    return { result: `Showed ${base(path)} (${pic.width}x${pic.height}) to the user inline.` }
  }).catch(() => ({ deny: 'inline-images: showing the image failed' }))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isRunning || e.props.isErrored) return row
    const input = (e.props.input ?? {}) as { file_path?: string; path?: string; caption?: string }
    const output = e.props.output as { type?: string } | undefined
    let path: string | undefined
    let caption: string | undefined
    if (e.props.tool === 'Read' && output?.type === 'image' && input.file_path && IMAGE.test(input.file_path)) {
      path = input.file_path
    } else if (e.props.tool === SHOW && input.path) {
      path = input.path
      caption = input.caption
    }
    if (!path) return row

    const pic = await picFor($, e.props.tool_use_id, path)
    if (!pic) return row
    const { Box, Button, Client, Image, Text } = $.ui.resolve(e)
    const room = Math.max(10, Math.min((e.viewport?.columns ?? 80) - 6, 120))
    const { columns, rows } = cells(pic, room)
    const shown = path
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Box position="relative" width={columns} height={rows}>
            <Image key="pic" source={{ png: pic.png }} columns={columns} rows={rows} alt={`[image: ${base(path)}]`} />
            <Box position="absolute" top={0} left={0}>
              <Client key="hit" module="./hit.tsx" props={{ path }} width={columns} height={rows} />
            </Box>
          </Box>
          <Box flexDirection="row" gap={1}>
            {caption ? <Text dimColor>{caption}</Text> : null}
            <Button key="zoom" plain label="⤢ zoom" onPress={() => void openViewer($, shown)} />
          </Box>
        </Box>
      </Box>
    )
  })

  // A click on a thumbnail (hit.tsx) opens it.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { open?: string } | null
    if (data?.open) await openViewer($, data.open)
    return next(e)
  })
}
