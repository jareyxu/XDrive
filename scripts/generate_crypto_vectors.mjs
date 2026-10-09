// Public compatibility fixtures only: fixed keys/nonces must never enter runtime encryption.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCipheriv } from 'node:crypto'
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/u,'')
const v1=JSON.parse(readFileSync(`${root}/tests/testdata/crypto-v1.json`)),v2=JSON.parse(readFileSync(`${root}/tests/testdata/crypto-v2.json`))
const vectors=[]
for(const [version,fixture,names] of [[1,v1,['keySlot','chunk','manifest','thumbnail','index','localState']],[2,v2,['keySlot','chunk','manifest','thumbnail']]]) for(const name of names) {
 const keyHex=version===2 && ['chunk','manifest'].includes(name)?v2.keyDerivation.fileKeyHex:version===2 && name==='thumbnail'?v2.keyDerivation.thumbnailKeyHex:v1.encryptedObject.keyHex
 for(const [label,plain] of [['empty',Buffer.alloc(0)],['one',Buffer.from([0xff])],['utf8',Buffer.from('\u6c49\u5b57 \ud83e\udd8a\n')]]) {
  const nonce=Buffer.from(v1.encryptedObject.nonceHex,'hex'),key=Buffer.from(keyHex,'hex'),aad=Buffer.from(fixture[name].aadHex,'hex')
  const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad)
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()])
  vectors.push({name:`v${version}/${name}/${label}`,keyHex,nonceHex:nonce.toString('hex'),plaintextHex:plain.toString('hex'),aadHex:aad.toString('hex'),envelopeHex:Buffer.concat([Buffer.from('5844525601010000','hex'),nonce,ciphertext]).toString('hex')})
 }
}
const keySlots=[v1,v2].map(fixture=>{
 const keyHex=v1.encryptedObject.keyHex,nonceHex=v1.encryptedObject.nonceHex,plaintextHex=v2.keyDerivation.vaultKeyHex
 const cipher=createCipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),Buffer.from(nonceHex,'hex'));cipher.setAAD(Buffer.from(fixture.keySlot.aadHex,'hex'))
 const ciphertext=Buffer.concat([cipher.update(Buffer.from(plaintextHex,'hex')),cipher.final(),cipher.getAuthTag()])
 return {input:fixture.keySlot.input,keyHex,nonceHex,plaintextHex,aadHex:fixture.keySlot.aadHex,ciphertextHex:ciphertext.toString('hex')}
})
writeFileSync(`${root}/tests/testdata/crypto-aead.json`,JSON.stringify({schema:1,note:'Public test keys and fixed nonces only. Generic AEAD binding vectors; key-slot business container remains separate. Never use these fixed nonce/key pairs in production.',vectors,keySlots},null,2)+'\n')

const u32=['0','1','4294967295'].map(decimal=>{const b=Buffer.alloc(4);b.writeUInt32BE(Number(decimal));return {decimal,hex:b.toString('hex')}})
const u64=['0','1','9007199254740991','9007199254740992','18446744073709551615'].map(decimal=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(decimal));return {decimal,hex:b.toString('hex')}})
const lp=['','\u6c49\u5b57 \ud83e\udd8a','e\u0301','\u00e9','\u0000'].map(value=>{const body=Buffer.from(value),length=Buffer.alloc(4);length.writeUInt32BE(body.length);return {value,hex:Buffer.concat([length,body]).toString('hex')}})
writeFileSync(`${root}/tests/testdata/crypto-encoding.json`,JSON.stringify({schema:1,u32,u64,lp},null,2)+'\n')
