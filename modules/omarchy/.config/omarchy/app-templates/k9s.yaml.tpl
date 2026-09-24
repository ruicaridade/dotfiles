k9s:
  body:
    fgColor: '{{ foreground }}'
    bgColor: '{{ background }}'
    logoColor: '{{ accent }}'
  prompt:
    fgColor: '{{ foreground }}'
    bgColor: '{{ background }}'
    suggestColor: '{{ cyan }}'
  help:
    fgColor: '{{ foreground }}'
    bgColor: '{{ background }}'
    sectionColor: '{{ accent }}'
    keyColor: '{{ cyan }}'
    numKeyColor: '{{ magenta }}'
  frame:
    title:
      fgColor: '{{ accent }}'
      bgColor: '{{ background }}'
      highlightColor: '{{ magenta }}'
      counterColor: '{{ yellow }}'
      filterColor: '{{ green }}'
    border:
      fgColor: '{{ muted }}'
      focusColor: '{{ accent }}'
    menu:
      fgColor: '{{ foreground }}'
      keyColor: '{{ cyan }}'
      numKeyColor: '{{ magenta }}'
    crumbs:
      fgColor: '{{ background }}'
      bgColor: '{{ accent }}'
      activeColor: '{{ cyan }}'
    status:
      # k9s uses newColor for ordinary rows, not just recently created ones.
      newColor: '{{ foreground }}'
      modifyColor: '{{ yellow }}'
      addColor: '{{ green }}'
      pendingColor: '{{ yellow }}'
      errorColor: '{{ red }}'
      highlightColor: '{{ magenta }}'
      killColor: '{{ red }}'
      completedColor: '{{ muted }}'
  info:
    fgColor: '{{ foreground }}'
    sectionColor: '{{ accent }}'
  views:
    table:
      fgColor: '{{ foreground }}'
      bgColor: '{{ background }}'
      cursorFgColor: '{{ selection_foreground }}'
      cursorBgColor: '{{ selection_background }}'
      markColor: '{{ magenta }}'
      header:
        fgColor: '{{ accent }}'
        bgColor: '{{ background }}'
        sorterColor: '{{ yellow }}'
        selectedSortColumnColor: '{{ cyan }}'
    xray:
      fgColor: '{{ foreground }}'
      bgColor: '{{ background }}'
      cursorColor: '{{ selection_background }}'
      cursorTextColor: '{{ selection_foreground }}'
      graphicColor: '{{ accent }}'
    charts:
      bgColor: '{{ background }}'
      chartBgColor: '{{ background }}'
      dialBgColor: '{{ background }}'
      defaultDialColors: ['{{ accent }}', '{{ red }}']
      defaultChartColors: ['{{ accent }}', '{{ red }}']
      resourceColors:
        cpu: ['{{ cyan }}', '{{ blue }}']
        mem: ['{{ green }}', '{{ yellow }}']
    yaml:
      keyColor: '{{ cyan }}'
      valueColor: '{{ foreground }}'
      colonColor: '{{ muted }}'
    logs:
      fgColor: '{{ foreground }}'
      bgColor: '{{ background }}'
      indicator:
        fgColor: '{{ accent }}'
        bgColor: '{{ background }}'
        toggleOnColor: '{{ green }}'
        toggleOffColor: '{{ muted }}'
  dialog:
    fgColor: '{{ foreground }}'
    bgColor: '{{ background }}'
    buttonFgColor: '{{ foreground }}'
    buttonBgColor: '{{ lighter_background }}'
    buttonFocusFgColor: '{{ background }}'
    buttonFocusBgColor: '{{ accent }}'
    labelFgColor: '{{ cyan }}'
    fieldFgColor: '{{ foreground }}'
