import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextFunction } from 'express'
import '../middleware/auth.js'

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn() },
    car: { findUnique: vi.fn(), create: vi.fn() },
    passenger: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
    userCar: { findUnique: vi.fn() },
  },
}))

vi.mock('../notifications/notification.service.js', () => ({
  notifyGroupMembers: vi.fn(),
}))

import { prisma } from '../lib/prisma.js'
import { notifyGroupMembers } from '../notifications/notification.service.js'
import { makeRes, makeReq, asRes } from './test-utils.js'
import { addCarHandler } from './cars.js'

const mockSessionFindUnique = vi.mocked(prisma.session.findUnique)
const mockGroupMemberFindUnique = vi.mocked(prisma.groupMember.findUnique)
const mockCarFindUnique = vi.mocked(prisma.car.findUnique)
const mockCarCreate = vi.mocked(prisma.car.create)
const mockPassengerUpsert = vi.mocked(prisma.passenger.upsert)
const mockUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockNotifyGroupMembers = vi.mocked(notifyGroupMembers)

const sessionDate = new Date(2026, 2, 21) // 21 mars 2026 (local time)

const futureSession = {
  id: 'session-1',
  groupId: 'group-1',
  date: sessionDate,
  startTime: new Date(Date.now() + 3600 * 1000),
}

const memberRole = { role: 'member' }

describe('POST /cars — notification CAR_AVAILABLE', () => {
  let mockRes: ReturnType<typeof makeRes>
  let mockNext: NextFunction

  beforeEach(() => {
    vi.clearAllMocks()
    mockRes = makeRes()
    mockNext = vi.fn()
    mockNotifyGroupMembers.mockResolvedValue(undefined)
    mockPassengerUpsert.mockResolvedValue({})
  })

  it('notifie les membres avec le bon message quand Alice propose sa voiture (3 places)', async () => {
    mockSessionFindUnique.mockResolvedValue(futureSession)
    mockGroupMemberFindUnique.mockResolvedValue(memberRole)
    mockCarFindUnique.mockResolvedValue(null)
    mockCarCreate.mockResolvedValue({ seats: 3, passengers: [] })
    mockUserFindUnique.mockResolvedValue({ name: 'Alice' })

    const req = makeReq({ body: { sessionId: 'session-1', seats: 3 }, user: { userId: 'user-1' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(201)
    expect(mockNext).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(mockNotifyGroupMembers).toHaveBeenCalled())

    expect(mockNotifyGroupMembers).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      expect.objectContaining({
        title: '🚗 Une voiture est disponible !',
        body: expect.stringContaining('Alice propose sa voiture'),
        type: 'CAR_AVAILABLE',
        url: '/groups/group-1',
      })
    )
  })

  it('indique le bon nombre de places disponibles (seats - passagers déjà embarqués)', async () => {
    mockSessionFindUnique.mockResolvedValue(futureSession)
    mockGroupMemberFindUnique.mockResolvedValue(memberRole)
    mockCarFindUnique.mockResolvedValue(null)
    // 4 sièges, 1 passager déjà embarqué → 3 places disponibles
    mockCarCreate.mockResolvedValue({ seats: 4, passengers: [{ userId: 'user-2' }] })
    mockUserFindUnique.mockResolvedValue({ name: 'Bob' })

    const req = makeReq({ body: { sessionId: 'session-1', seats: 4 }, user: { userId: 'user-1' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    await vi.waitFor(() => expect(mockNotifyGroupMembers).toHaveBeenCalled())

    expect(mockNotifyGroupMembers).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      expect.objectContaining({
        body: expect.stringContaining('Il reste 3 places disponibles'),
      })
    )
  })

  it('utilise le singulier quand il reste 1 place', async () => {
    mockSessionFindUnique.mockResolvedValue(futureSession)
    mockGroupMemberFindUnique.mockResolvedValue(memberRole)
    mockCarFindUnique.mockResolvedValue(null)
    mockCarCreate.mockResolvedValue({ seats: 1, passengers: [] })
    mockUserFindUnique.mockResolvedValue({ name: 'Bob' })

    const req = makeReq({ body: { sessionId: 'session-1', seats: 1 }, user: { userId: 'user-1' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    await vi.waitFor(() => expect(mockNotifyGroupMembers).toHaveBeenCalled())

    expect(mockNotifyGroupMembers).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      expect.objectContaining({
        body: expect.stringContaining('Il reste 1 place disponible'),
      })
    )
  })

  it("utilise 'Quelqu'un' si le nom du chauffeur est introuvable", async () => {
    mockSessionFindUnique.mockResolvedValue(futureSession)
    mockGroupMemberFindUnique.mockResolvedValue(memberRole)
    mockCarFindUnique.mockResolvedValue(null)
    mockCarCreate.mockResolvedValue({ seats: 3, passengers: [] })
    mockUserFindUnique.mockResolvedValue(null)

    const req = makeReq({ body: { sessionId: 'session-1', seats: 3 }, user: { userId: 'user-unknown' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    await vi.waitFor(() => expect(mockNotifyGroupMembers).toHaveBeenCalled())

    expect(mockNotifyGroupMembers).toHaveBeenCalledWith(
      'group-1',
      'user-unknown',
      expect.objectContaining({
        body: expect.stringContaining("Quelqu'un propose sa voiture"),
      })
    )
  })

  it("retourne 400 si l'utilisateur a déjà une voiture dans cette séance", async () => {
    mockSessionFindUnique.mockResolvedValue(futureSession)
    mockGroupMemberFindUnique.mockResolvedValue(memberRole)
    mockCarFindUnique.mockResolvedValue({ id: 'car-existing' })

    const req = makeReq({ body: { sessionId: 'session-1', seats: 3 }, user: { userId: 'user-1' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(mockNotifyGroupMembers).not.toHaveBeenCalled()
  })

  it("retourne 404 si la session n'existe pas", async () => {
    mockSessionFindUnique.mockResolvedValue(null)

    const req = makeReq({ body: { sessionId: 'session-inexistante', seats: 3 }, user: { userId: 'user-1' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
    expect(mockNotifyGroupMembers).not.toHaveBeenCalled()
  })

  it("retourne 403 si l'utilisateur n'est pas membre du groupe", async () => {
    mockSessionFindUnique.mockResolvedValue(futureSession)
    mockGroupMemberFindUnique.mockResolvedValue(null)

    const req = makeReq({ body: { sessionId: 'session-1', seats: 3 }, user: { userId: 'user-outsider' } })

    await addCarHandler(req, asRes(mockRes), mockNext)

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(mockNotifyGroupMembers).not.toHaveBeenCalled()
  })
})
