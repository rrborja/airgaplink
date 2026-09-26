import type { DecodeFailure, DecodedOpticalFrame } from './index.ts'

interface CandidateGroup {
  at: number
  samples: Uint8Array[]
}

/** Recovers repeated optical payloads with independent camera bit errors.
 * The metadata CRC identifies a candidate group; the payload CRC must pass
 * before any recovered bytes can reach FEC or the handshake parser. */
export class TemporalOpticalRecovery {
  private readonly groups = new Map<string, CandidateGroup>()
  private readonly checksum: (bytes: Uint8Array) => number
  recovered = 0
  lastCandidateCount = 0

  constructor(checksum: (bytes: Uint8Array) => number) { this.checksum = checksum }

  clear() { this.groups.clear(); this.lastCandidateCount = 0 }

  add(failure: DecodeFailure, now: number): DecodedOpticalFrame | null {
    const header = failure.header, candidate = failure.candidatePayload
    if (failure.reason !== 'payload-crc' || !header || !candidate || !Number.isFinite(now) || candidate.length !== header.payloadLength || candidate.length < 1 || candidate.length > 16384) return null
    for (const [key, group] of this.groups) if (now - group.at > 15000) this.groups.delete(key)
    const key = `${header.version}:${header.profileId}:${header.blockId}:${header.payloadLength}:${header.payloadCrc32}`
    let group = this.groups.get(key)
    if (!group) {
      if (this.groups.size >= 32) this.groups.delete(this.groups.keys().next().value!)
      group = { at: now, samples: [] }
      this.groups.set(key, group)
    }
    group.at = now
    // Capturing one held screen image several times can repeat the same error.
    // Count distinct byte patterns so it cannot outvote other observations.
    if (!group.samples.some(sample => sample.every((value, index) => value === candidate[index]))) {
      group.samples.push(candidate.slice())
      if (group.samples.length > 7) group.samples.shift()
    }
    this.lastCandidateCount = group.samples.length
    if (group.samples.length < 3 || group.samples.length % 2 === 0) return null
    const majority = new Uint8Array(candidate.length)
    for (let index = 0; index < majority.length; index += 1) for (let bit = 0; bit < 8; bit += 1) {
      let votes = 0
      for (const sample of group.samples) votes += (sample[index] >>> bit) & 1
      if (votes > group.samples.length / 2) majority[index] |= 1 << bit
    }
    if (this.checksum(majority) !== header.payloadCrc32) return null
    this.groups.delete(key)
    this.recovered += 1
    return { ok: true, header, payload: majority, metadataAgreement: failure.metadataAgreement || 0, recovery: 'temporal-majority' }
  }
}
