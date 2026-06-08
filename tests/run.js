import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { api, waitForServer, BASE } from './helpers.js'
import { record, setMetrics, writeResults } from './collector.js'

// Wrap assert + record into one call
function check(category, name, value, detail = '') {
  record(category, name, !!value, detail)
  assert.ok(value, `${name}${detail ? ' -- ' + detail : ''}`)
}

before(async () => {
  await waitForServer()
})

after(() => {
  writeResults()
})

// ============================================================
// FASE 1: Regras de negocio via API
// ============================================================
describe('Regras de negocio (API)', { concurrency: 1 }, () => {

  it('health check', async () => {
    const r = await api('GET', '/api/health')
    check('rules', 'Health check', r.status === 200 && r.data?.status === 'ok')
  })

  it('cria transacao visa 1x', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '4111111111111111', holder_name: 'Bench Test', expiration: '12/28',
      cvv: '123', amount_cents: 10000, installments: 1, description: 'Visa 1x', idempotency_key: 'bench-001'
    })
    check('rules', 'POST retorna 201', r.status === 201)
    check('rules', 'Status approved', r.data?.status === 'approved')
    check('rules', 'Bandeira visa (4xxx)', r.data?.card_brand === 'visa')
    check('rules', 'Taxa visa 2.5% (250)', r.data?.fee_cents === 250)
    check('rules', 'net_amount = amount - fee (9750)', r.data?.net_amount === 9750)
  })

  it('idempotencia: mesma key retorna 200', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '4111111111111111', holder_name: 'Bench Test', expiration: '12/28',
      cvv: '123', amount_cents: 10000, installments: 1, description: 'Visa 1x', idempotency_key: 'bench-001'
    })
    check('rules', 'Idempotencia retorna 200', r.status === 200)
  })

  it('detecta mastercard (5xxx)', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '5222222222222222', holder_name: 'MC Test', expiration: '12/28',
      cvv: '123', amount_cents: 20000, installments: 1, description: 'MC', idempotency_key: 'bench-002'
    })
    check('rules', 'Bandeira mastercard (5xxx)', r.data?.card_brand === 'mastercard')
    check('rules', 'Taxa mastercard 3% (600)', r.data?.fee_cents === 600)
  })

  it('detecta amex (3xxx)', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '3333333333333333', holder_name: 'Amex Test', expiration: '12/28',
      cvv: '1234', amount_cents: 10000, installments: 1, description: 'Amex', idempotency_key: 'bench-002b'
    })
    check('rules', 'Bandeira amex (3xxx)', r.data?.card_brand === 'amex')
  })

  it('detecta elo (6xxx)', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '6444444444444444', holder_name: 'Elo Test', expiration: '12/28',
      cvv: '123', amount_cents: 10000, installments: 1, description: 'Elo', idempotency_key: 'bench-002c'
    })
    check('rules', 'Bandeira elo (6xxx)', r.data?.card_brand === 'elo')
  })

  it('cartao 9999 retorna declined', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '9999555555555555', holder_name: 'Declined', expiration: '12/28',
      cvv: '123', amount_cents: 10000, installments: 1, description: 'Declined', idempotency_key: 'bench-003'
    })
    check('rules', 'Cartao 9999 declined', r.data?.status === 'declined')
    check('rules', 'Declined salvo (201)', r.status === 201)
  })

  it('bandeira invalida rejeitada 422', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '1111111111111111', holder_name: 'Bad', expiration: '12/28',
      cvv: '123', amount_cents: 10000, installments: 1, description: 'Bad', idempotency_key: 'bench-004'
    })
    check('rules', 'Bandeira invalida 422', r.status === 422)
  })

  it('juros compostos 2%/mes (3x)', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '4666666666666666', holder_name: 'Joao Silva', expiration: '12/28',
      cvv: '123', amount_cents: 15000, installments: 3, description: 'Camiseta SENAI', idempotency_key: 'bench-005'
    })
    check('rules', 'total_with_interest correto (15919)', r.data?.total_with_interest === 15919,
      `recebido=${r.data?.total_with_interest}`)
    check('rules', 'installment_amount com ceil (5307)', r.data?.installment_amount === 5307,
      `recebido=${r.data?.installment_amount}`)
    check('rules', 'Taxa sobre amount_cents (375)', r.data?.fee_cents === 375)
    check('rules', 'net_amount correto (14625)', r.data?.net_amount === 14625)
  })

  it('juros compostos 4%/mes (7x)', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '4777777777777777', holder_name: 'Test 7x', expiration: '12/28',
      cvv: '123', amount_cents: 100000, installments: 7, description: '7 parcelas', idempotency_key: 'bench-005b'
    })
    const expected = Math.ceil(100000 * Math.pow(1.04, 7))
    check('rules', 'Juros 4%/mes (7x)', r.data?.total_with_interest === expected,
      `esperado=${expected} recebido=${r.data?.total_with_interest}`)
  })

  it('parcela abaixo R$10 rejeitada', async () => {
    const r = await api('POST', '/api/transactions', {
      card_number: '4888888888888888', holder_name: 'Min', expiration: '12/28',
      cvv: '123', amount_cents: 1000, installments: 12, description: 'Min', idempotency_key: 'bench-006'
    })
    check('rules', 'Parcela minima R$10 422', r.status === 422)
  })

  it('estorno funciona', async () => {
    const tx = await api('POST', '/api/transactions', {
      card_number: '4999999999999999', holder_name: 'Refund Test', expiration: '12/28',
      cvv: '123', amount_cents: 5000, installments: 1, description: 'Para estorno', idempotency_key: 'bench-refund-001'
    })
    assert.equal(tx.status, 201, 'Precisa criar transacao para estornar')

    const refund = await api('POST', `/api/transactions/${tx.data.id}/refund`)
    check('rules', 'Estorno approved -> refunded', refund.data?.status === 'refunded',
      `status=${refund.data?.status}`)

    const double = await api('POST', `/api/transactions/${tx.data.id}/refund`)
    check('rules', 'Double refund rejeitado 422', double.status === 422,
      `status=${double.status}`)
  })

  it('balance endpoint', async () => {
    const r = await api('GET', '/api/balance')
    check('rules', 'Balance funciona', r.status === 200 && r.data?.balance_cents != null)
    check('rules', 'Declined nao conta no saldo', r.data?.total_declined > 0)
  })

  it('paginacao', async () => {
    const r = await api('GET', '/api/transactions?page=1&limit=2')
    check('rules', 'Paginacao funciona', r.data?.pagination?.total_pages > 0)
  })
})

// ============================================================
// FASE 2: Frontend via Playwright
// ============================================================
describe('Frontend (Playwright)', { concurrency: 1 }, () => {
  let browser, page

  before(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  after(async () => {
    if (browser) await browser.close()
  })

  it('dashboard carrega', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    check('frontend', 'Dashboard carrega', true)
  })

  it('formulario tem todos os campos', async () => {
    const fields = [
      '.input-card-number', '.input-holder-name', '.input-expiration',
      '.input-cvv', '.input-amount', '.select-installments',
      '.input-description', '.btn-pay'
    ]
    for (const sel of fields) {
      const el = await page.$(sel)
      check('frontend', `Elemento ${sel}`, el !== null)
    }
  })

  it('saldo tem elementos corretos', async () => {
    const fields = [
      '.display-balance', '.display-total-approved',
      '.display-total-declined', '.display-total-refunded'
    ]
    for (const sel of fields) {
      const el = await page.$(sel)
      check('frontend', `Elemento ${sel}`, el !== null)
    }
  })

  it('submit do formulario funciona', async () => {
    await page.fill('.input-card-number', '4222222222222222')
    await page.fill('.input-holder-name', 'Playwright Test')
    await page.fill('.input-expiration', '12/29')
    await page.fill('.input-cvv', '999')
    await page.fill('.input-amount', '25000')
    await page.selectOption('.select-installments', '1')
    await page.fill('.input-description', 'Teste Playwright')
    await page.click('.btn-pay')

    await page.waitForSelector('.feedback-success, .feedback-error', { timeout: 5000 })
    const success = await page.$('.feedback-success')
    check('frontend', 'Feedback apos submit', true)
    check('frontend', 'Transacao aprovada via form', success !== null)
  })

  it('historico carrega com transacoes', async () => {
    await page.goto(BASE + '/history?page=1&limit=10', { waitUntil: 'networkidle' })
    check('frontend', 'Pagina /history carrega', true)

    const list = await page.$('.list-transactions')
    check('frontend', 'Lista de transacoes existe', list !== null)

    const items = await page.$$('.transaction-item')
    check('frontend', 'Transacoes no historico', items.length > 0, `${items.length} items`)

    if (items.length > 0) {
      const fields = [
        '.transaction-id', '.transaction-status', '.transaction-amount',
        '.transaction-brand', '.transaction-installments', '.transaction-fee',
        '.transaction-description'
      ]
      for (const sel of fields) {
        const el = await items[0].$(sel)
        check('frontend', `Item tem ${sel}`, el !== null)
      }
    }
  })

  it('paginacao tem elementos corretos', async () => {
    const fields = [
      '.pagination-current', '.pagination-pages', '.pagination-total',
      '.btn-prev-page', '.btn-next-page'
    ]
    for (const sel of fields) {
      const el = await page.$(sel)
      check('frontend', `Paginacao ${sel}`, el !== null)
    }
  })

  it('detalhe da transacao', async () => {
    const items = await page.$$('.transaction-item')
    if (items.length === 0) {
      check('frontend', 'Pagina /transaction/:id carrega', false, 'sem transacoes')
      return
    }

    const id = await items[0].$eval('.transaction-id', el => el.dataset.value || el.textContent)
    await page.goto(BASE + '/transaction/' + id, { waitUntil: 'networkidle' })
    check('frontend', 'Pagina /transaction/:id carrega', true)

    const fields = [
      '.detail-id', '.detail-status', '.detail-amount', '.detail-brand',
      '.detail-holder', '.detail-card', '.detail-installments', '.detail-fee',
      '.detail-net', '.detail-description', '.detail-date'
    ]
    for (const sel of fields) {
      const el = await page.$(sel)
      check('frontend', `Detalhe ${sel}`, el !== null)
    }
  })

  it('SPA fallback funciona', async () => {
    const resp = await page.goto(BASE + '/history', { waitUntil: 'networkidle' })
    check('frontend', 'SPA fallback (/history sem query)', resp.status() === 200)
  })
})

// ============================================================
// FASE 3: Stress via API
// ============================================================
describe('Stress test (API)', { concurrency: 1 }, () => {

  it('throughput com 20 workers', async () => {
    const TOTAL = 200
    const CONCURRENCY = 20
    let created = 0, errors500 = 0, errors422 = 0
    const latencies = []
    const ts = Date.now()
    const start = Date.now()

    let nextIdx = 0
    async function worker() {
      while (true) {
        const idx = nextIdx++
        if (idx >= TOTAL) return
        const brands = ['4', '5', '3', '6']
        const brand = brands[idx % 4]
        const suffix = String(idx).padStart(4, '0')
        const cardNum = `${brand}${String(idx).padStart(11, '0')}${suffix}`
        const reqStart = Date.now()
        try {
          const r = await api('POST', '/api/transactions', {
            card_number: cardNum, holder_name: `Stress ${idx}`, expiration: '12/29',
            cvv: '123', amount_cents: 1000, installments: 1, description: `Stress ${idx}`,
            idempotency_key: `stress-${idx}-${ts}`
          })
          latencies.push(Date.now() - reqStart)
          if (r.status === 201) created++
          else if (r.status >= 500) errors500++
          else if (r.status === 422) errors422++
        } catch {
          latencies.push(Date.now() - reqStart)
          errors500++
        }
      }
    }

    const workers = []
    for (let w = 0; w < CONCURRENCY; w++) workers.push(worker())
    await Promise.all(workers)

    const elapsed = Date.now() - start
    const throughput = Math.round(created / (elapsed / 1000))

    latencies.sort((a, b) => a - b)
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)

    setMetrics({ throughput, stress_elapsed_ms: elapsed, stress_created: created,
      stress_total: TOTAL, latency_p50_ms: p50, latency_p95_ms: p95,
      latency_p99_ms: p99, latency_avg_ms: avg })

    check('stress', `${created}/${TOTAL} transacoes criadas`, created >= TOTAL * 0.8,
      `${errors500} err500, ${errors422} err422`)
    check('stress', 'Zero erros 500', errors500 === 0, errors500 > 0 ? `${errors500} erros` : '')
    check('stress', `Throughput >= 50 txn/s`, throughput >= 50, `${throughput} txn/s, ${elapsed}ms`)
    check('stress', `P95 < 500ms`, p95 < 500, `p50=${p50}ms p95=${p95}ms p99=${p99}ms avg=${avg}ms`)
  })

  it('idempotencia concorrente (10 workers)', async () => {
    const key = `idem-stress-${Date.now()}`
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(api('POST', '/api/transactions', {
        card_number: '4100000000000100', holder_name: 'Idem Stress', expiration: '12/28',
        cvv: '123', amount_cents: 1000, installments: 1, description: 'Idem', idempotency_key: key
      }))
    }
    const res = await Promise.all(promises)
    const c201 = res.filter(r => r.status === 201).length
    const c200 = res.filter(r => r.status === 200).length
    check('stress', 'Idempotencia concorrente', (c201 + c200 === 10) && c201 >= 1,
      `201=${c201} 200=${c200}`)
  })

  it('double refund concorrente (5 workers)', async () => {
    const tx = await api('POST', '/api/transactions', {
      card_number: '4200000000000200', holder_name: 'Refund Stress', expiration: '12/28',
      cvv: '123', amount_cents: 1000, installments: 1, description: 'Stress refund',
      idempotency_key: `stress-refund-${Date.now()}`
    })
    assert.equal(tx.status, 201)

    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(api('POST', `/api/transactions/${tx.data.id}/refund`))
    }
    const res = await Promise.all(promises)
    const refunded = res.filter(r => r.data?.status === 'refunded').length
    check('stress', 'Apenas 1 estorno concorrente', refunded === 1, `${refunded} estornos`)
  })

  it('read/write concorrente', async () => {
    const ts = Date.now()
    const writes = []
    const reads = []
    for (let i = 0; i < 50; i++) {
      writes.push(api('POST', '/api/transactions', {
        card_number: `4${String(i + 5000).padStart(15, '0')}`,
        holder_name: `Burst ${i}`, expiration: '12/29', cvv: '123',
        amount_cents: 1000, installments: 1, description: `Burst ${i}`,
        idempotency_key: `burst-${i}-${ts}`
      }))
      reads.push(api('GET', '/api/transactions?page=1&limit=5'))
    }
    const all = await Promise.all([...writes, ...reads])
    const wOk = all.slice(0, 50).filter(r => r.status === 201).length
    const rOk = all.slice(50).filter(r => r.status === 200).length
    check('stress', `Read/Write concorrente`, wOk >= 40 && rOk >= 45,
      `${wOk}/50 writes, ${rOk}/50 reads`)
  })
})
