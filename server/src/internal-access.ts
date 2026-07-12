// Internal dashboards are reachable only from loopback. Fastify trusts proxy
// headers solely when the immediate peer is the local Caddy instance, so a
// public request proxied by Caddy retains its real client IP and is rejected.
import type { FastifyReply, FastifyRequest } from 'fastify'

export function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

export async function requireLoopback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isLoopbackIp(request.ip)) {
    await reply.code(404).send({ error: 'Not found' })
  }
}
