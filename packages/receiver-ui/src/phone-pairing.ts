export interface PhonePairing { id: string; token: string }

export function hasPhonePairingHash(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, '')).has('phone')
}

export function parsePhonePairingHash(hash: string): PhonePairing | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('phone')
  if (!value || !/^[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{32}$/.test(value)) return null
  const [id, token] = value.split('.')
  return { id, token }
}
