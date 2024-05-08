const ClientComponent = require('./component')

const AsyncModule = require('./async')

module.exports = function Index() {
  return <ClientComponent promise={AsyncModule} />
}
