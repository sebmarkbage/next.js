import { nextTestSetup } from 'e2e-utils'

const WITH_PPR = !!process.env.__NEXT_EXPERIMENTAL_PPR

const stackStart = /\s+at /

function createExpectError(cliOutput: string) {
  let cliIndex = 0
  return function expectError(
    containing: string,
    withStackContaining?: string
  ): Array<string> {
    const initialCliIndex = cliIndex
    let lines = cliOutput.slice(cliIndex).split('\n')

    let i = 0
    while (i < lines.length) {
      let line = lines[i++] + '\n'
      cliIndex += line.length
      if (line.includes(containing)) {
        if (typeof withStackContaining !== 'string') {
          return
        } else {
          while (i < lines.length) {
            let stackLine = lines[i++] + '\n'
            if (!stackStart.test(stackLine)) {
              expect(stackLine).toContain(withStackContaining)
            }
            if (stackLine.includes(withStackContaining)) {
              return
            }
          }
        }
      }
    }

    expect(cliOutput.slice(initialCliIndex)).toContain(containing)
  }
}

function runTests(options: { withMinification: boolean }) {
  const isTurbopack = !!process.env.TURBOPACK
  const { withMinification } = options
  describe(`Dynamic IO Errors - ${withMinification ? 'With Minification' : 'Without Minification'}`, () => {
    describe('Dynamic Metadata - Static Route', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/dynamic-metadata-static-route',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      it('should error the build if generateMetadata is dynamic', async () => {
        try {
          await next.start()
        } catch {
          // we expect the build to fail
        }
        const expectError = createExpectError(next.cliOutput)

        expectError('Error occurred prerendering page "/"')
        expectError(
          'Error: Route / has a dynamic `generateMetadata` but nothing else is dynamic.'
        )
      })
    })

    describe('Dynamic Metadata - Dynamic Route', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/dynamic-metadata-dynamic-route',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      it('should partially prerender when all dynamic components are inside a Suspense boundary', async () => {
        try {
          await next.start()
        } catch {
          throw new Error('expected build not to fail for fully static project')
        }

        expect(next.cliOutput).toContain('ƒ / ')
        const $ = await next.render$('/')
        expect($('#dynamic').text()).toBe('Dynamic')
        expect($('[data-fallback]').length).toBe(0)
      })
    })

    describe('Dynamic Viewport - Static Route', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/dynamic-viewport-static-route',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      it('should error the build if generateViewport is dynamic', async () => {
        try {
          await next.start()
        } catch {
          // we expect the build to fail
        }
        const expectError = createExpectError(next.cliOutput)

        expectError('Error occurred prerendering page "/"')
        expectError(
          'Error: Route / has a dynamic `generateViewport` but nothing else is dynamic.'
        )
      })
    })

    describe('Dynamic Viewport - Dynamic Route', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/dynamic-viewport-dynamic-route',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      it('should partially prerender when all dynamic components are inside a Suspense boundary', async () => {
        try {
          await next.start()
        } catch {
          throw new Error('expected build not to fail for fully static project')
        }

        expect(next.cliOutput).toContain('ƒ / ')
        const $ = await next.render$('/')
        expect($('#dynamic').text()).toBe('Dynamic')
        expect($('[data-fallback]').length).toBe(0)
      })
    })

    describe('Static Route', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/static',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      it('should not error the build when all routes are static', async () => {
        try {
          await next.start()
        } catch {
          // we expect the build to fail
          throw new Error('expected build not to fail for fully static project')
        }
      })
    })

    describe('Dynamic Root', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/dynamic-root',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      it('should error the build if dynamic IO happens in the root (outside a Suspense)', async () => {
        try {
          await next.start()
        } catch {
          // we expect the build to fail
        }
        const expectError = createExpectError(next.cliOutput)

        expectError(
          'Error: Route / performed an IO operation that was not cached and no Suspense boundary was found to define a fallback UI.',
          // Turbopack doesn't support disabling minification yet
          withMinification || isTurbopack ? undefined : 'IndirectionTwo'
        )
        if (WITH_PPR) {
          // React currently fatals the render in canary because we don't have access to the prerender API there. with a fatal only
          // one task actually reports and error at the moment. We should fix upstream but for now we exclude the second error when PPR is off
          // because we are using canary React and renderToReadableStream rather than experimental React and prerender
          expectError(
            'Error: Route / performed an IO operation that was not cached and no Suspense boundary was found to define a fallback UI.',
            // Turbopack doesn't support disabling minification yet
            withMinification || isTurbopack ? undefined : 'IndirectionThree'
          )
        }
        expectError('Error occurred prerendering page "/"')
        expectError(
          'Error: Route / has one or more dynamic components without a defined fallback UI.'
        )
        expectError('exiting the build.')
      })
    })

    describe('Dynamic Boundary', () => {
      const { next, isNextDev, skipped } = nextTestSetup({
        files: __dirname + '/fixtures/dynamic-boundary',
        skipStart: true,
      })

      if (skipped) {
        return
      }

      if (isNextDev) {
        it('does not run in dev', () => {})
        return
      }

      beforeEach(async () => {
        if (!withMinification) {
          await next.patchFile('next.config.js', (content) =>
            content.replace(
              'serverMinification: true,',
              'serverMinification: false,'
            )
          )
        }
      })

      if (WITH_PPR) {
        it('should partially prerender when all dynamic components are inside a Suspense boundary', async () => {
          try {
            await next.start()
          } catch {
            throw new Error(
              'expected build not to fail for fully static project'
            )
            // we expect the build to fail
          }

          expect(next.cliOutput).toContain('◐ / ')
          const $ = await next.render$('/')
          expect($('[data-fallback]').length).toBe(2)
        })
      } else {
        it('should not error the build when all dynamic components are inside a Suspense boundary', async () => {
          try {
            await next.start()
          } catch {
            throw new Error(
              'expected build not to fail for fully static project'
            )
          }

          expect(next.cliOutput).toContain('ƒ / ')
          const $ = await next.render$('/')
          expect($('[data-fallback]').length).toBe(2)
        })
      }
    })
  })
}

runTests({ withMinification: true })
runTests({ withMinification: false })
