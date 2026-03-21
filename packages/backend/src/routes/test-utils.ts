import { vi } from 'vitest'
import type { Request, Response } from 'express'

export function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

export function makeReq(data: {
  params?: Record<string, string>
  body?: unknown
  user?: { userId: string }
}): Request {
  return data as unknown as Request
}

export function asRes(res: ReturnType<typeof makeRes>): Response {
  return res as unknown as Response
}
