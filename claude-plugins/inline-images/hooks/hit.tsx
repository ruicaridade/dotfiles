import type { ClientModule } from 'claude-code'

// An invisible box over a thumbnail: a left click (no drag) asks the hooks module
// to open the image in the viewer pane. It draws no cells of its own, so the
// picture underneath stays visible.
type Props = { path: string }
type State = { isReady: true }

const Hit: ClientModule<Props, State> = (props, surface) => {
  if (surface.state === undefined) {
    let down: { x: number; y: number } | null = null
    surface.onPointer(e => {
      if (e.type === 'down' && e.button === 'left') down = { x: e.x, y: e.y }
      else if (e.type === 'up' && down) {
        const isClick = Math.abs(e.x - down.x) + Math.abs(e.y - down.y) <= 1
        down = null
        if (isClick) surface.post({ open: props.path })
      }
    })
    surface.setState({ isReady: true })
  }
  const { Box } = surface.elements
  return <Box width={surface.columns} height={surface.rows} />
}

export default Hit
