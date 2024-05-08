'use client'

const World = require('./other')

module.exports = function Component({ promise }) {
  return (
    <span>
      Hello {World[Symbol.toStringTag]}+{promise[Symbol.toStringTag]}
    </span>
  )
}
