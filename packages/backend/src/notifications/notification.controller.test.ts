import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'

vi.mock('./notification.service.js', () => ({
  saveSubscription: vi.fn(),
  removeSubscription: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import { saveSubscription, removeSubscription } from './notification.service.js'

const mockSaveSubscription = saveSubscription as ReturnType<typeof vi.fn>
const mockRemoveSubscription = removeSubscription as ReturnType<typeof vi.fn>

const mockSub = {
  endpoint: 'https://fcm.googleapis.com/push/abc123',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
}

function makeRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  }
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

async function subscribeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const body = req.body as Record<string, unknown>
  const missing = ['subscription'].filter((f) => body[f] === undefined)
  if (missing.length > 0) {
    res.status(400).json({ error: `Champs manquants : ${missing.join(', ')}` })
    return
  }
  try {
    await saveSubscription(req.user!.userId, body.subscription as Parameters<typeof saveSubscription>[1])
    res.status(201).json({ message: 'Abonnement enregistré' })
  } catch (err) {
    next(err)
  }
}

async function unsubscribeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await removeSubscription(req.user!.userId)
    res.status(200).json({ message: 'Désabonnement effectué' })
  } catch (err) {
    next(err)
  }
}

function vapidPublicKeyHandler(req: Request, res: Response): void {
  const key = process.env.VAPID_PUBLIC_KEY
  if (!key) {
    res.status(503).json({ error: 'Push notifications non configurées' })
    return
  }
  res.json({ vapidPublicKey: key })
}

describe('POST /notifications/subscribe', () => {
  let mockReq: Record<string, unknown>
  let mockRes: ReturnType<typeof makeRes>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {
      user: { userId: 'user-123' },
      body: { subscription: mockSub },
    }
    mockRes = makeRes()
    mockNext = vi.fn()
    vi.clearAllMocks()
  })

  it('returns 201 with success message when subscription is saved', async () => {
    mockSaveSubscription.mockResolvedValue(undefined)

    await subscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(201)
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Abonnement enregistré' })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('calls saveSubscription with the authenticated user id', async () => {
    mockSaveSubscription.mockResolvedValue(undefined)

    await subscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockSaveSubscription).toHaveBeenCalledWith('user-123', mockSub)
  })

  it('returns 400 when subscription field is missing', async () => {
    mockReq.body = {}

    await subscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Champs manquants : subscription' })
    expect(mockSaveSubscription).not.toHaveBeenCalled()
  })

  it('passes errors from saveSubscription to next middleware', async () => {
    const err = new Error('DB failure')
    mockSaveSubscription.mockRejectedValue(err)

    await subscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith(err)
    expect(mockRes.status).not.toHaveBeenCalledWith(201)
  })
})

describe('POST /notifications/unsubscribe', () => {
  let mockReq: Record<string, unknown>
  let mockRes: ReturnType<typeof makeRes>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = { user: { userId: 'user-123' } }
    mockRes = makeRes()
    mockNext = vi.fn()
    vi.clearAllMocks()
  })

  it('returns 200 with success message when unsubscribed', async () => {
    mockRemoveSubscription.mockResolvedValue(undefined)

    await unsubscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Désabonnement effectué' })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('calls removeSubscription with the authenticated user id', async () => {
    mockRemoveSubscription.mockResolvedValue(undefined)

    await unsubscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockRemoveSubscription).toHaveBeenCalledWith('user-123')
  })

  it('passes errors from removeSubscription to next middleware', async () => {
    const err = new Error('DB failure')
    mockRemoveSubscription.mockRejectedValue(err)

    await unsubscribeHandler(mockReq as unknown as Request, mockRes as unknown as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith(err)
  })
})

describe('GET /notifications/vapid-public-key', () => {
  let mockReq: Record<string, unknown>
  let mockRes: ReturnType<typeof makeRes>

  beforeEach(() => {
    mockReq = {}
    mockRes = makeRes()
    delete process.env.VAPID_PUBLIC_KEY
  })

  it('returns the VAPID public key when configured', () => {
    process.env.VAPID_PUBLIC_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtwe...'

    vapidPublicKeyHandler(mockReq as unknown as Request, mockRes as unknown as Response)

    expect(mockRes.json).toHaveBeenCalledWith({ vapidPublicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtwe...' })
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('returns 503 when VAPID_PUBLIC_KEY env var is not set', () => {
    vapidPublicKeyHandler(mockReq as unknown as Request, mockRes as unknown as Response)

    expect(mockRes.status).toHaveBeenCalledWith(503)
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Push notifications non configurées' })
  })
})
