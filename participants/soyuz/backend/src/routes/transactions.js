import prisma from '../db.js'

const BRAND_RULES = {
  3: { brand: 'amex', fee: 0.035 },
  4: { brand: 'visa', fee: 0.025 },
  5: { brand: 'mastercard', fee: 0.03 },
  6: { brand: 'elo', fee: 0.04 },
}

const DAILY_LIMIT_CENTS = 500000

function error(message) {
  return { error: message }
}

function toApi(tx) {
  return {
    id: tx.id,
    status: tx.status,
    card_last4: tx.cardLast4,
    card_brand: tx.cardBrand,
    holder_name: tx.holderName,
    amount_cents: tx.amountCents,
    installments: tx.installments,
    installment_amount: tx.installmentAmount,
    total_with_interest: tx.totalWithInterest,
    fee_cents: tx.feeCents,
    net_amount: tx.netAmount,
    description: tx.description,
    expiration: tx.expiration,
    created_at: tx.createdAt.toISOString(),
    refunded_at: tx.refundedAt?.toISOString() ?? null,
  }
}

function detectBrand(cardNumber) {
  return BRAND_RULES[cardNumber[0]] ?? null
}

function interestRate(installments) {
  if (installments === 1) return 0
  if (installments <= 6) return 0.02
  return 0.04
}

function calculate(amountCents, installments, brandFee) {
  const rate = interestRate(installments)
  const totalWithInterest = Math.ceil(amountCents * Math.pow(1 + rate, installments))
  const installmentAmount = Math.ceil(totalWithInterest / installments)
  const feeCents = Math.round(amountCents * brandFee)
  const netAmount = amountCents - feeCents

  return { totalWithInterest, installmentAmount, feeCents, netAmount }
}

function hasHtml(value) {
  return /<[^>]*>/.test(value)
}

function expirationIsValid(expiration) {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiration)
  if (!match) return false

  const month = Number(match[1])
  const year = 2000 + Number(match[2])
  if (month < 1 || month > 12) return false

  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  return year > currentYear || (year === currentYear && month >= currentMonth)
}

function validateBody(body) {
  const {
    card_number,
    holder_name,
    expiration,
    cvv,
    amount_cents,
    installments = 1,
    description,
  } = body ?? {}

  if (!Number.isInteger(amount_cents) || amount_cents <= 0 || amount_cents > 1000000) {
    return 'amount_cents invalido'
  }
  if (!/^\d{16}$/.test(String(card_number ?? ''))) return 'card_number invalido'
  if (!/^\d{3,4}$/.test(String(cvv ?? ''))) return 'cvv invalido'
  if (typeof holder_name !== 'string' || holder_name.trim() === '' || holder_name.length > 50 || hasHtml(holder_name)) {
    return 'holder_name invalido'
  }
  if (typeof expiration !== 'string' || !expirationIsValid(expiration)) return 'expiration invalida'
  if (!Number.isInteger(installments) || installments < 1 || installments > 12) return 'installments invalido'
  if (typeof description !== 'string' || description.trim() === '' || description.length > 100) {
    return 'description invalida'
  }

  return null
}

function idempotencyKey(body) {
  if (typeof body.idempotency_key === 'string' && body.idempotency_key.trim() !== '') {
    return body.idempotency_key.trim()
  }

  return JSON.stringify({
    card_number: body.card_number,
    holder_name: body.holder_name,
    expiration: body.expiration,
    amount_cents: body.amount_cents,
    installments: body.installments ?? 1,
    description: body.description,
  })
}

async function withBusyRetry(operation, attempts = 5) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (err) {
      lastError = err
      const message = `${err?.message ?? ''} ${err?.code ?? ''}`.toLowerCase()
      if (!message.includes('busy') && !message.includes('locked')) throw err
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  throw lastError
}

async function dailyApprovedAmount(cardLast4) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(start.getDate() + 1)

  const result = await prisma.transaction.aggregate({
    _sum: { amountCents: true },
    where: {
      cardLast4,
      status: 'approved',
      createdAt: { gte: start, lt: end },
    },
  })

  return result._sum.amountCents ?? 0
}

export default async function (fastify) {

  fastify.get('/health', async () => ({ status: 'ok' }))

  fastify.get('/balance', async (req, reply) => {
    const [approved, declined, refunded, balance] = await Promise.all([
      prisma.transaction.count({ where: { status: 'approved' } }),
      prisma.transaction.count({ where: { status: 'declined' } }),
      prisma.transaction.count({ where: { status: 'refunded' } }),
      prisma.transaction.aggregate({
        _sum: { netAmount: true },
        where: { status: 'approved' },
      }),
    ])

    reply.send({
      balance_cents: balance._sum.netAmount ?? 0,
      total_approved: approved,
      total_declined: declined,
      total_refunded: refunded,
    })
  })

  fastify.post('/transactions', async (req, reply) => {
    const body = req.body ?? {}
    const validationError = validateBody(body)
    if (validationError) return reply.code(422).send(error(validationError))

    const key = idempotencyKey(body)
    const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: key } })
    if (existing) return reply.code(200).send(toApi(existing))

    const declinedByCard = body.card_number.startsWith('9999')
    const rule = detectBrand(body.card_number)
    if (!rule && !declinedByCard) return reply.code(422).send(error('bandeira invalida'))

    const cardLast4 = body.card_number.slice(-4)
    const brand = rule?.brand ?? 'unknown'
    const fee = rule?.fee ?? 0
    const installments = body.installments ?? 1
    const amounts = calculate(body.amount_cents, installments, fee)

    if (amounts.totalWithInterest / installments < 1000) {
      return reply.code(422).send(error('valor minimo da parcela invalido'))
    }

    const usedToday = await dailyApprovedAmount(cardLast4)
    const declinedByLimit = !declinedByCard && usedToday + body.amount_cents > DAILY_LIMIT_CENTS
    const status = declinedByCard || declinedByLimit ? 'declined' : 'approved'

    try {
      const tx = await withBusyRetry(() => prisma.transaction.create({
        data: {
          status,
          cardLast4,
          cardBrand: brand,
          holderName: body.holder_name.trim(),
          amountCents: body.amount_cents,
          installments,
          installmentAmount: amounts.installmentAmount,
          totalWithInterest: amounts.totalWithInterest,
          feeCents: amounts.feeCents,
          netAmount: status === 'approved' ? amounts.netAmount : 0,
          description: body.description.trim(),
          expiration: body.expiration,
          idempotencyKey: key,
        },
      }))

      return reply.code(201).send(toApi(tx))
    } catch (err) {
      if (err?.code === 'P2002' || `${err?.message ?? ''}`.includes('UNIQUE')) {
        const tx = await prisma.transaction.findUnique({ where: { idempotencyKey: key } })
        if (tx) return reply.code(200).send(toApi(tx))
      }
      throw err
    }
  })

  fastify.get('/transactions/:id', async (req, reply) => {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } })
    if (!tx) return reply.code(404).send(error('transacao nao encontrada'))
    reply.send(toApi(tx))
  })

  fastify.get('/transactions', async (req, reply) => {
    const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? '10', 10) || 10))
    const skip = (page - 1) * limit

    const [total, data] = await Promise.all([
      prisma.transaction.count(),
      prisma.transaction.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ])

    reply.send({
      data: data.map(toApi),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    })
  })

  fastify.post('/transactions/:id/refund', async (req, reply) => {
    const result = await withBusyRetry(() => prisma.transaction.updateMany({
      where: { id: req.params.id, status: 'approved' },
      data: { status: 'refunded', refundedAt: new Date(), netAmount: 0 },
    }))

    if (result.count === 0) return reply.code(422).send(error('estorno invalido'))

    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } })
    reply.send(toApi(tx))
  })
}
