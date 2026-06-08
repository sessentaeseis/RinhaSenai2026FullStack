import { writeFileSync } from 'node:fs'

const results = { rules: [], frontend: [], stress: [], metrics: {} }

export function record(category, name, ok, detail = '') {
  results[category].push({ name, ok, detail })
}

export function setMetrics(metrics) {
  Object.assign(results.metrics, metrics)
}

export function writeResults(outputPath = 'tests/results.json') {
  const rulesPass = results.rules.filter(t => t.ok).length
  const rulesTotal = results.rules.length
  const frontendPass = results.frontend.filter(t => t.ok).length
  const frontendTotal = results.frontend.length
  const stressPass = results.stress.filter(t => t.ok).length
  const stressTotal = results.stress.length

  const pass = rulesPass + frontendPass + stressPass
  const total = rulesTotal + frontendTotal + stressTotal

  const rulesScore = Math.round((rulesPass / Math.max(rulesTotal, 1)) * 50)
  const frontendScore = Math.round((frontendPass / Math.max(frontendTotal, 1)) * 30)
  const stressScore = Math.round((stressPass / Math.max(stressTotal, 1)) * 20)

  results.summary = { pass, fail: total - pass, total }
  results.scoring = {
    rules: { pass: rulesPass, total: rulesTotal, score: rulesScore, max: 50 },
    frontend: { pass: frontendPass, total: frontendTotal, score: frontendScore, max: 30 },
    stress: { pass: stressPass, total: stressTotal, score: stressScore, max: 20 },
    total: rulesScore + frontendScore + stressScore,
  }

  writeFileSync(outputPath, JSON.stringify(results, null, 2))
}
