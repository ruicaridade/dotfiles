import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "ruicaridade.agents"
  ipcTarget: "ruicaridade.agents"
  manageIpc: false
  property var providers: [
    {name: "Claude", limits: [], stale: true, updatedAt: 0},
    {name: "Codex", limits: [], stale: true, updatedAt: 0}
  ]
  property double nowMs: Date.now()
  property bool pendingRefresh: false
  property string failure: ""
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool alarming: providers.some(function(p) {
    return (p.limits || []).some(function(limit) { return Number(limit.percent) >= 0.9 })
  })
  // Omarchy uses these to size the open-panel underline. The default is icon-sized.
  readonly property real openPanelIndicatorWidth: logos.implicitWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function refresh(force) {
    if (collector.running) {
      pendingRefresh = pendingRefresh || force === true
      return
    }
    collector.command = ["python3", pluginDir + "usage.py", "snapshot"].concat(force === true ? ["--force"] : [])
    collector.running = true
  }
  function colorFor(limit) {
    return Number(limit.percent) >= 0.9 ? Color.urgent : Color.accent
  }
  function tooltip() {
    var lines = ["Subscription usage remaining"]
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i]
      lines.push(p.name + (Model.stale(p, nowMs) ? " — stale / unavailable" : ""))
      for (var j = 0; j < (p.limits || []).length; j++) {
        var w = p.limits[j]
        lines.push("  " + w.label + ": " + Model.remaining(w) + "% left; resets in " + Model.reset(w.resetsAt, nowMs))
      }
      if (p.error) lines.push("  " + p.error)
    }
    lines.push("Click for details · Right-click to refresh")
    return lines.join("\n")
  }
  onOpenedChanged: if (opened) { refresh(false); Qt.callLater(function() { keys.forceActiveFocus() }) }

  Timer { interval: 30000; running: true; repeat: true; triggeredOnStart: true; onTriggered: root.refresh(false) }
  Timer { interval: 1000; running: true; repeat: true; onTriggered: root.nowMs = Date.now() }
  Process {
    id: collector
    running: false
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          var result = JSON.parse(text)
          if (!Array.isArray(result.providers) || result.providers.length !== 2) throw new Error("Invalid usage result")
          root.providers = result.providers
          root.failure = ""
          root.nowMs = Date.now()
        } catch (error) { root.failure = "Could not read usage; keeping the last result" }
      }
    }
    onExited: function(code) {
      if (code !== 0) root.failure = "Usage collector failed; keeping the last result"
      if (root.pendingRefresh) { root.pendingRefresh = false; Qt.callLater(function() { root.refresh(true) }) }
    }
  }
  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(true); return "ok" }
  }
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: vertical ? -1 : logos.implicitWidth + scaledHorizontalMargin * 2
    fixedHeight: vertical ? Style.bar.iconSlot : -1
    Row {
      id: logos
      anchors.centerIn: parent
      spacing: Style.space(14)
      Repeater {
        model: root.providers
        delegate: Row {
          id: providerLabel
          required property var modelData
          spacing: Style.space(5)
          Image {
            width: Style.bar.iconCanvas
            height: width
            anchors.verticalCenter: parent.verticalCenter
            source: Qt.resolvedUrl("assets/" + (providerLabel.modelData.name === "Claude" ? "claude.svg" :
                (root.foreground.r + root.foreground.g + root.foreground.b > 1.5 ? "codex.svg" : "codex-light.svg")))
            sourceSize.width: width * 2
            sourceSize.height: height * 2
          }
          Text {
            visible: !button.vertical
            text: Model.headline(providerLabel.modelData, root.nowMs).replace(providerLabel.modelData.name + " ", "")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            height: Style.bar.iconCanvas
            verticalAlignment: Text.AlignVCenter
          }
        }
      }
    }
    tooltipText: root.tooltip()
    active: root.alarming
    onPressed: function(code) {
      if (code === Qt.RightButton || code === Qt.MiddleButton) root.refresh(true)
      else root.toggle()
    }
  }
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(body.implicitHeight, Style.space(520))
    PanelKeyCatcher {
      id: keys
      anchors.fill: parent
      onCloseRequested: root.close()
      onActivateRequested: root.refresh(true)
      onTextKey: function(text) { if (text.toLowerCase() === "r") root.refresh(true) }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: body.implicitHeight
        clip: true
        Column {
          id: body
          width: parent.width
          spacing: Style.space(16)
          Text {
            text: "Usage remaining"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
          }
          Repeater {
            model: root.providers
            delegate: Column {
              id: providerCard
              required property var modelData
              width: body.width
              spacing: Style.space(8)
              Text {
                text: providerCard.modelData.name + (Model.stale(providerCard.modelData, root.nowMs) ? "  ·  stale" : "")
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Repeater {
                model: providerCard.modelData.limits || []
                delegate: Column {
                  id: windowRow
                  required property var modelData
                  width: providerCard.width
                  spacing: Style.space(4)
                  Row {
                    width: parent.width
                    Text {
                      width: parent.width * 0.65
                      text: windowRow.modelData.label
                      elide: Text.ElideRight
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      width: parent.width * 0.35
                      horizontalAlignment: Text.AlignRight
                      text: Model.reset(windowRow.modelData.resetsAt, root.nowMs) === "refreshing" ? "Refreshing…" : Model.remaining(windowRow.modelData) + "% left"
                      color: root.colorFor(windowRow.modelData)
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                    }
                  }
                  Rectangle {
                    width: parent.width
                    height: Style.space(4)
                    radius: height / 2
                    color: Style.selectedFillFor(root.foreground, Color.accent)
                    Rectangle {
                      width: parent.width * Math.max(0, Math.min(1, 1 - Number(windowRow.modelData.percent)))
                      height: parent.height
                      radius: parent.radius
                      color: root.colorFor(windowRow.modelData)
                    }
                  }
                  Text {
                    text: "Resets in " + Model.reset(windowRow.modelData.resetsAt, root.nowMs)
                    color: root.foreground
                    opacity: 0.65
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                }
              }
              Text {
                width: parent.width
                visible: !!providerCard.modelData.error
                text: providerCard.modelData.error || ""
                wrapMode: Text.Wrap
                color: Color.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }
          Text {
            width: parent.width
            text: root.failure || (collector.running ? "Refreshing…" : "Updates every 30s · R to refresh")
            color: root.foreground
            opacity: 0.65
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }
        }
      }
    }
  }
}
