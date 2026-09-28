import { OpticalBlockCollector, readCalibrationFrameId, unpackOpticalSymbol, type OpticalImageDecode, type ReedSolomonBlockCodec } from '../../optical-core/src/index.ts'
import { type PhoneRelayMessage } from './phone-relay-protocol.ts'

/** The phone handles optical CRC and Reed–Solomon reconstruction. It cannot
 * decrypt file blocks; only the desktop holds the session AES key. */
export class PhoneBlockAssembler {
  private readonly codec: ReedSolomonBlockCodec
  private collectors = new Map<string, OpticalBlockCollector>()
  private sentVisits = new Set<string>()
  private acknowledged = new Set<number>()
  private pendingBlocks = new Map<number, number>()
  private observed = new Set<string>()
  private lastControl: { fingerprint: string; at: number } | null = null
  recoveredBlocks = 0
  repeatedFrames = 0
  usefulShards = 0
  usefulShardBytes = 0

  constructor(codec: ReedSolomonBlockCodec) { this.codec = codec }

  acknowledge(blockId: number) { this.acknowledged.add(blockId); this.pendingBlocks.delete(blockId); for (const key of this.collectors.keys()) if (key.startsWith(`${blockId}:`)) this.collectors.delete(key) }
  clear() { this.collectors.clear(); this.sentVisits.clear(); this.acknowledged.clear(); this.pendingBlocks.clear(); this.observed.clear(); this.lastControl = null; this.recoveredBlocks = 0; this.repeatedFrames = 0; this.usefulShards = 0; this.usefulShardBytes = 0 }

  accept(result: OpticalImageDecode, now: number): PhoneRelayMessage[] {
    if (!result.ok) return []
    const symbol = unpackOpticalSymbol(result.payload)
    if (!symbol) {
      if (result.payload.length > 512) return []
      const fingerprint = Array.from(result.payload).join(',')
      if (this.lastControl?.fingerprint === fingerprint && now - this.lastControl.at < 2000) { this.repeatedFrames += 1; return [] }
      this.lastControl = { fingerprint, at: now }
      return [{ kind: 'control', profileId: result.header.profileId, frameId: result.header.frameId, blockId: result.header.blockId, payload: result.payload }]
    }
    if (symbol.blockId !== result.header.blockId || symbol.sourceCount !== 8 || symbol.repairCount !== 2) return []
    const messages: PhoneRelayMessage[] = []
    const calibration = readCalibrationFrameId(result.header.frameId)
    if (calibration || result.header.frameId === 0) {
      const key = `${result.header.frameId}:${symbol.blockId}:${symbol.visit ?? -1}:${symbol.index}`
      if (!this.observed.has(key)) {
        this.observed.add(key)
        if (this.observed.size > 1024) this.observed.delete(this.observed.values().next().value!)
        messages.push({ kind: 'observation', profileId: result.header.profileId, frameId: result.header.frameId, transferId: symbol.transferId, blockId: symbol.blockId, shardIndex: symbol.index })
      }
    }
    if (this.acknowledged.has(symbol.blockId) || symbol.visit === undefined) return messages
    // A block already sent to the desktop needs no further FEC work. Permit a
    // fresh visit after a timeout in case the local link dropped before ACK.
    const pendingAt = this.pendingBlocks.get(symbol.blockId)
    if (pendingAt !== undefined && now - pendingAt < 3000) { this.repeatedFrames += 1; return messages }
    const key = `${symbol.blockId}:${symbol.visit}`
    if (this.sentVisits.has(key)) { this.repeatedFrames += 1; return messages }
    let collector = this.collectors.get(key)
    if (!collector) {
      if (this.collectors.size >= 64) this.collectors.delete(this.collectors.keys().next().value!)
      collector = new OpticalBlockCollector(this.codec, symbol.transferId, symbol.blockId, symbol.visit)
      this.collectors.set(key, collector)
    }
    const before = collector.count
    let ciphertext: Uint8Array | null
    try { ciphertext = collector.add(symbol) }
    catch { this.collectors.delete(key); return messages }
    if (collector.count === before) this.repeatedFrames += 1
    else { this.usefulShards += 1; this.usefulShardBytes += symbol.bytes.length }
    if (!ciphertext) return messages
    this.collectors.delete(key); this.sentVisits.add(key)
    if (this.sentVisits.size > 16384) this.sentVisits.delete(this.sentVisits.values().next().value!)
    this.recoveredBlocks += 1
    this.pendingBlocks.set(symbol.blockId, now)
    if (this.pendingBlocks.size > 256) this.pendingBlocks.delete(this.pendingBlocks.keys().next().value!)
    messages.push({ kind: 'block', profileId: result.header.profileId, transferId: symbol.transferId, blockId: symbol.blockId, visit: symbol.visit, bytes: ciphertext })
    return messages
  }
}

/** A 120-FPS camera can see the same 60-Hz display frame more than once.
 * Retain the highest-confidence CRC-valid capture until the next display ID
 * or a short timeout. Repeated frame-zero alignment shards use their symbol
 * index as part of the identity. */
export class PhoneDisplayFrameSelector {
  private pending: { key: string; result: OpticalImageDecode & { ok: true }; at: number } | null = null
  repeatedCaptures = 0
  accept(result: OpticalImageDecode, now: number) {
    if (!result.ok) return null
    const symbol = result.header.frameId === 0 ? unpackOpticalSymbol(result.payload) : null
    const key = `${result.header.frameId}:${result.header.blockId}${symbol ? `:${symbol.visit ?? -1}:${symbol.index}` : ''}`
    if (this.pending?.key === key) {
      this.repeatedCaptures += 1
      if ((result.symbolConfidence || 0) > (this.pending.result.symbolConfidence || 0)) this.pending.result = result
      return null
    }
    const previous = this.pending?.result || null
    this.pending = { key, result, at: now }
    return previous
  }
  flush(now: number) {
    if (!this.pending || now - this.pending.at < 40) return null
    const result = this.pending.result
    this.pending = null
    return result
  }
  clear() { this.pending = null; this.repeatedCaptures = 0 }
}
