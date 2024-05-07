'use client'

const World = require('./other')

export default function Index() {
  return <div>Hello {World[Symbol.toStringTag]}</div>
}
