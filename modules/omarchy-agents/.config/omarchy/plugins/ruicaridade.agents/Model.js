function remaining(limit) {
  var used = Number(limit.percent)
  return isFinite(used) ? Math.round(100 * (1 - Math.max(0, Math.min(1, used)))) : null
}
function stale(provider, now) {
  return !!provider.stale || !provider.updatedAt || now / 1000 - provider.updatedAt > 90
}
function reset(value, now) {
  var end = Date.parse(value)
  if (!isFinite(end)) return ""
  if (end <= now) return "refreshing"
  var minutes = Math.ceil((end - now) / 60000)
  var days = Math.floor(minutes / 1440)
  var hours = Math.floor(minutes / 60) % 24
  return days ? days + "d " + hours + "h" : hours ? hours + "h " + minutes % 60 + "m" : minutes + "m"
}
function headline(provider, now) {
  var limits = provider.limits || []
  var main = limits.filter(function(limit) {
    return !/fable|sonnet|opus/i.test(limit.label)
  })
  var values = main.map(function(limit) {
    return Date.parse(limit.resetsAt) <= now ? "…" : remaining(limit) + "%"
  })
  return provider.name + " " + (values.length ? values.join("/") + (stale(provider, now) ? "*" : "") : "—")
}
