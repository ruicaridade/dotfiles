import type { EngineInterface, Register } from 'claude-code'

// Pictures inline in the terminal (kitty graphics in kitty, Ghostty and Herdr):
// a thumbnail under every Read of an image file, and a `show_image` tool the
// model calls to put a picture in front of the person.

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

type Pic = { png: string; width: number; height: number }

// Converted pictures by tool_use_id; a reload starts it empty and reconverts.
const pics = new Map<string, Promise<Pic | null>>()

const base = (path: string) => path.split('/').pop() ?? path

// Any image magick reads, as a PNG small enough for Image.
async function convert($: EngineInterface, path: string, id: string): Promise<Pic | null> {
  await $.process.run(['mkdir', '-p', CACHE])
  for (const edge of EDGES) {
    const out = `${CACHE}/${id.replace(/[^\w-]/g, '_')}-${edge}.png`
    if (!(await $.fs.exists(out))) {
      const made = await $.process.run(
        ['magick', `${path}[0]`, '-auto-orient', '-resize', `${edge}x${edge}>`, '-strip', out],
        { timeoutMs: 20000 },
      )
      if (made.exitCode !== 0) return null
    }
    const size = await $.process.run(['magick', 'identify', '-format', '%w %h', out])
    const [width, height] = size.stdout.trim().split(' ').map(Number)
    if (!width || !height) return null
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    if ((base64.length * 3) / 4 <= MAX_BYTES) return { png: base64, width, height }
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

// The box in cells: natural size, no wider than the room, no taller than MAX_ROWS.
function cells(pic: Pic, room: number) {
  let columns = Math.min(Math.ceil(pic.width / CELL_W), room, 255)
  let rows = Math.round((columns * CELL_W * pic.height) / pic.width / CELL_H)
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.round((rows * CELL_H * pic.width) / pic.height / CELL_W)
  }
  return { columns: Math.max(1, Math.min(columns, 255)), rows: Math.max(1, Math.min(rows, 255)) }
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
    return started
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
    const { Box, Image, Text } = $.ui.resolve(e)
    const room = Math.max(10, Math.min((e.viewport?.columns ?? 80) - 6, 120))
    const { columns, rows } = cells(pic, room)
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Image key="pic" source={{ png: pic.png }} columns={columns} rows={rows} alt={`[image: ${base(path)}]`} />
          {caption ? <Text dimColor>{caption}</Text> : null}
        </Box>
      </Box>
    )
  })
}
