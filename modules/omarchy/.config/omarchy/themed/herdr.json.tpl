{
  "background": "{{ background }}",
  "foreground": "{{ foreground }}",
  "selection": "{{ selection }}",
  "cursor": "{{ cursor }}",
  "ansi": [
    "{{ color0 }}", "{{ color1 }}", "{{ color2 }}", "{{ color3 }}",
    "{{ color4 }}", "{{ color5 }}", "{{ color6 }}", "{{ color7 }}",
    "{{ color8 }}", "{{ color9 }}", "{{ color10 }}", "{{ color11 }}",
    "{{ color12 }}", "{{ color13 }}", "{{ color14 }}", "{{ color15 }}"
  ],
  "colors": {
    "chrome": "{{ dark_background }}",
    "canvas": "{{ mix dark_background background 50% }}",
    "surface": "{{ background }}",
    "popover": "{{ lighter_background }}",
    "raised": "{{ mix background foreground 10% }}",

    "foreground": "{{ foreground }}",
    "muted": "{{ mix foreground background 20% }}",
    "dim": "{{ mix foreground background 40% }}",
    "idle": "{{ mix foreground background 40% }}",
    "unknown": "{{ mix foreground background 40% }}",

    "hover": "{{ foreground }}14",
    "selected": "{{ foreground }}2e",
    "border": "{{ foreground }}1f",
    "input": "{{ foreground }}33",
    "ring": "{{ accent }}",

    "accent": "{{ accent }}",
    "accent_foreground": "{{ background }}",
    "solid": "{{ foreground }}",
    "solid_foreground": "{{ background }}"
  }
}
