import type { NextConfig } from '../../config-shared'
import type { AppRouteRouteDefinition } from '../../route-definitions/app-route-route-definition'
import type { AppSegmentConfig } from '../../../build/app-segments/app-segment-config'
import type { NextRequest } from '../../web/spec-extension/request'
import type { PrerenderManifest } from '../../../build'
import type { NextURL } from '../../web/next-url'
import type { DeepReadonly } from '../../../shared/lib/deep-readonly'

import {
  RouteModule,
  type RouteModuleHandleContext,
  type RouteModuleOptions,
} from '../route-module'
import {
  withRequestStore,
  type RequestContext,
} from '../../async-storage/with-request-store'
import {
  withWorkStore,
  type StaticGenerationContext,
} from '../../async-storage/with-work-store'
import {
  handleBadRequestResponse,
  handleInternalServerErrorResponse,
} from '../helpers/response-handlers'
import { type HTTP_METHOD, HTTP_METHODS, isHTTPMethod } from '../../web/http'
import { addImplicitTags, patchFetch } from '../../lib/patch-fetch'
import { getTracer } from '../../lib/trace/tracer'
import { AppRouteRouteHandlersSpan } from '../../lib/trace/constants'
import { getPathnameFromAbsolutePath } from './helpers/get-pathname-from-absolute-path'
import { resolveHandlerError } from './helpers/resolve-handler-error'
import * as Log from '../../../build/output/log'
import { autoImplementMethods } from './helpers/auto-implement-methods'
import {
  appendMutableCookies,
  type ReadonlyRequestCookies,
} from '../../web/spec-extension/adapters/request-cookies'
import { HeadersAdapter } from '../../web/spec-extension/adapters/headers'
import { RequestCookiesAdapter } from '../../web/spec-extension/adapters/request-cookies'
import { parsedUrlQueryToParams } from './helpers/parsed-url-query-to-params'

import * as serverHooks from '../../../client/components/hooks-server-context'
import { DynamicServerError } from '../../../client/components/hooks-server-context'

import { requestAsyncStorage } from '../../../client/components/request-async-storage.external'
import {
  staticGenerationAsyncStorage,
  type WorkStore,
} from '../../../client/components/work-async-storage.external'
import {
  prerenderAsyncStorage,
  type PrerenderStore,
} from '../../app-render/prerender-async-storage.external'
import { actionAsyncStorage } from '../../../client/components/action-async-storage.external'
import * as sharedModules from './shared-modules'
import { getIsServerAction } from '../../lib/server-action-request-meta'
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies'
import { cleanURL } from './helpers/clean-url'
import { StaticGenBailoutError } from '../../../client/components/static-generation-bailout'
import { isStaticGenEnabled } from './helpers/is-static-gen-enabled'
import {
  trackDynamicDataAccessed,
  createDynamicTrackingState,
  getFirstDynamicReason,
  isPrerenderInterruptedError,
} from '../../app-render/dynamic-rendering'
import { ReflectAdapter } from '../../web/spec-extension/adapters/reflect'
import type { RenderOptsPartial } from '../../app-render/types'
import { CacheSignal } from '../../app-render/cache-signal'
import { scheduleImmediate } from '../../../lib/scheduler'
import { createServerParamsForRoute } from '../../request/params'
import type { AppSegment } from '../../../build/app-segments/collect-app-segments'

/**
 * The AppRouteModule is the type of the module exported by the bundled App
 * Route module.
 */
export type AppRouteModule = typeof import('../../../build/templates/app-route')

/**
 * AppRouteRouteHandlerContext is the context that is passed to the route
 * handler for app routes.
 */
export interface AppRouteRouteHandlerContext extends RouteModuleHandleContext {
  renderOpts: StaticGenerationContext['renderOpts'] &
    Pick<RenderOptsPartial, 'onInstrumentationRequestError'>
  prerenderManifest: DeepReadonly<PrerenderManifest>
}

/**
 * AppRouteHandlerFnContext is the context that is passed to the handler as the
 * second argument.
 */
type AppRouteHandlerFnContext = {
  params?: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Handler function for app routes. If a non-Response value is returned, an error
 * will be thrown.
 */
export type AppRouteHandlerFn = (
  /**
   * Incoming request object.
   */
  req: NextRequest,
  /**
   * Context properties on the request (including the parameters if this was a
   * dynamic route).
   */
  ctx: AppRouteHandlerFnContext
) => unknown

/**
 * AppRouteHandlers describes the handlers for app routes that is provided by
 * the userland module.
 */
export type AppRouteHandlers = {
  [method in HTTP_METHOD]?: AppRouteHandlerFn
}

/**
 * AppRouteUserlandModule is the userland module that is provided for app
 * routes. This contains all the user generated code.
 */
export type AppRouteUserlandModule = AppRouteHandlers &
  Pick<
    AppSegmentConfig,
    'dynamic' | 'revalidate' | 'dynamicParams' | 'fetchCache'
  > &
  Pick<AppSegment, 'generateStaticParams'>

/**
 * AppRouteRouteModuleOptions is the options that are passed to the app route
 * module from the bundled code.
 */
export interface AppRouteRouteModuleOptions
  extends RouteModuleOptions<AppRouteRouteDefinition, AppRouteUserlandModule> {
  readonly resolvedPagePath: string
  readonly nextConfigOutput: NextConfig['output']
}

/**
 * AppRouteRouteHandler is the handler for app routes.
 */
export class AppRouteRouteModule extends RouteModule<
  AppRouteRouteDefinition,
  AppRouteUserlandModule
> {
  /**
   * A reference to the request async storage.
   */
  public readonly requestAsyncStorage = requestAsyncStorage

  /**
   * A reference to the static generation async storage.
   */
  public readonly staticGenerationAsyncStorage = staticGenerationAsyncStorage

  /**
   * prerenderAsyncStorage is used to scope a prerender context for renders ocurring
   * during a build or revalidate.
   */
  public readonly prerenderAsyncStorage = prerenderAsyncStorage

  /**
   * An interface to call server hooks which interact with the underlying
   * storage.
   */
  public readonly serverHooks = serverHooks

  public static readonly sharedModules = sharedModules

  /**
   * A reference to the mutation related async storage, such as mutations of
   * cookies.
   */
  public readonly actionAsyncStorage = actionAsyncStorage

  public readonly resolvedPagePath: string
  public readonly nextConfigOutput: NextConfig['output'] | undefined

  private readonly methods: Record<HTTP_METHOD, AppRouteHandlerFn>
  private readonly hasNonStaticMethods: boolean
  private readonly dynamic: AppRouteUserlandModule['dynamic']

  constructor({
    userland,
    definition,
    resolvedPagePath,
    nextConfigOutput,
  }: AppRouteRouteModuleOptions) {
    super({ userland, definition })

    this.resolvedPagePath = resolvedPagePath
    this.nextConfigOutput = nextConfigOutput

    // Automatically implement some methods if they aren't implemented by the
    // userland module.
    this.methods = autoImplementMethods(userland)

    // Get the non-static methods for this route.
    this.hasNonStaticMethods = hasNonStaticMethods(userland)

    // Get the dynamic property from the userland module.
    this.dynamic = this.userland.dynamic
    if (this.nextConfigOutput === 'export') {
      if (this.dynamic === 'force-dynamic') {
        throw new Error(
          `export const dynamic = "force-dynamic" on page "${definition.pathname}" cannot be used with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export`
        )
      } else if (!isStaticGenEnabled(this.userland) && this.userland['GET']) {
        throw new Error(
          `export const dynamic = "force-static"/export const revalidate not configured on route "${definition.pathname}" with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export`
        )
      } else {
        this.dynamic = 'error'
      }
    }

    // We only warn in development after here, so return if we're not in
    // development.
    if (process.env.NODE_ENV === 'development') {
      // Print error in development if the exported handlers are in lowercase, only
      // uppercase handlers are supported.
      const lowercased = HTTP_METHODS.map((method) => method.toLowerCase())
      for (const method of lowercased) {
        if (method in this.userland) {
          Log.error(
            `Detected lowercase method '${method}' in '${
              this.resolvedPagePath
            }'. Export the uppercase '${method.toUpperCase()}' method name to fix this error.`
          )
        }
      }

      // Print error if the module exports a default handler, they must use named
      // exports for each HTTP method.
      if ('default' in this.userland) {
        Log.error(
          `Detected default export in '${this.resolvedPagePath}'. Export a named export for each HTTP method instead.`
        )
      }

      // If there is no methods exported by this module, then return a not found
      // response.
      if (!HTTP_METHODS.some((method) => method in this.userland)) {
        Log.error(
          `No HTTP methods exported in '${this.resolvedPagePath}'. Export a named export for each HTTP method.`
        )
      }
    }
  }

  /**
   * Resolves the handler function for the given method.
   *
   * @param method the requested method
   * @returns the handler function for the given method
   */
  private resolve(method: string): AppRouteHandlerFn {
    // Ensure that the requested method is a valid method (to prevent RCE's).
    if (!isHTTPMethod(method)) return handleBadRequestResponse

    // Return the handler.
    return this.methods[method]
  }

  /**
   * Executes the route handler.
   */
  private async execute(
    rawRequest: NextRequest,
    context: AppRouteRouteHandlerContext
  ): Promise<Response> {
    // Get the handler function for the given method.
    const handler = this.resolve(rawRequest.method)

    // Get the context for the request.
    const requestContext: RequestContext = {
      req: rawRequest,
      res: undefined,
      url: rawRequest.nextUrl,
      renderOpts: {
        previewProps: context.prerenderManifest.preview,
        waitUntil: context.renderOpts.waitUntil,
        onClose: context.renderOpts.onClose,
        experimental: context.renderOpts.experimental,
      },
    }

    const dynamicIOEnabled = !!context.renderOpts.experimental?.dynamicIO

    // Get the context for the static generation.
    const staticGenerationContext: StaticGenerationContext = {
      // App Routes don't support unknown route params.
      fallbackRouteParams: null,
      page: this.definition.page,
      renderOpts: context.renderOpts,
    }

    // Add the fetchCache option to the renderOpts.
    staticGenerationContext.renderOpts.fetchCache = this.userland.fetchCache

    // Run the handler with the request AsyncLocalStorage to inject the helper
    // support. We set this to `unknown` because the type is not known until
    // runtime when we do a instanceof check below.
    const response: unknown = await this.actionAsyncStorage.run(
      {
        isAppRoute: true,
        isAction: getIsServerAction(rawRequest),
      },
      () =>
        withRequestStore(
          this.requestAsyncStorage,
          requestContext,
          (requestStore) =>
            withWorkStore(
              this.staticGenerationAsyncStorage,
              staticGenerationContext,
              (workStore) => {
                // Check to see if we should bail out of static generation based on
                // having non-static methods.
                const isStaticGeneration = workStore.isStaticGeneration

                if (this.hasNonStaticMethods) {
                  if (isStaticGeneration) {
                    const err = new DynamicServerError(
                      'Route is configured with methods that cannot be statically generated.'
                    )
                    workStore.dynamicUsageDescription = err.message
                    workStore.dynamicUsageStack = err.stack
                    throw err
                  } else {
                    // We aren't statically generating but since this route has non-static methods
                    // we still need to set the default caching to no cache by setting revalidate = 0
                    // @TODO this type of logic is too indirect. we need to refactor how we set fetch cache
                    // behavior. Prior to the most recent refactor this logic was buried deep in staticGenerationBailout
                    // so it is possible it was unintentional and then tests were written to assert the current behavior
                    workStore.revalidate = 0
                  }
                }

                // We assume we can pass the original request through however we may end up
                // proxying it in certain circumstances based on execution type and configuration
                let request = rawRequest

                // Update the static generation store based on the dynamic property.
                switch (this.dynamic) {
                  case 'force-dynamic': {
                    // Routes of generated paths should be dynamic
                    workStore.forceDynamic = true
                    break
                  }
                  case 'force-static':
                    // The dynamic property is set to force-static, so we should
                    // force the page to be static.
                    workStore.forceStatic = true
                    // We also Proxy the request to replace dynamic data on the request
                    // with empty stubs to allow for safely executing as static
                    request = new Proxy(rawRequest, forceStaticRequestHandlers)
                    break
                  case 'error':
                    // The dynamic property is set to error, so we should throw an
                    // error if the page is being statically generated.
                    workStore.dynamicShouldError = true
                    if (isStaticGeneration)
                      request = new Proxy(
                        rawRequest,
                        requireStaticRequestHandlers
                      )
                    break
                  default:
                    // We proxy `NextRequest` to track dynamic access, and potentially bail out of static generation
                    request = proxyNextRequest(rawRequest, workStore)
                }

                // If the static generation store does not have a revalidate value
                // set, then we should set it the revalidate value from the userland
                // module or default to false.
                workStore.revalidate ??= this.userland.revalidate ?? false

                // TODO: propagate this pathname from route matcher
                const route = getPathnameFromAbsolutePath(this.resolvedPagePath)
                getTracer().getRootSpanAttributes()?.set('next.route', route)
                return getTracer().trace(
                  AppRouteRouteHandlersSpan.runHandler,
                  {
                    spanName: `executing api route (app) ${route}`,
                    attributes: {
                      'next.route': route,
                    },
                  },
                  async () => {
                    // Patch the global fetch.
                    patchFetch({
                      staticGenerationAsyncStorage:
                        this.staticGenerationAsyncStorage,
                      requestAsyncStorage: this.requestAsyncStorage,
                      prerenderAsyncStorage: this.prerenderAsyncStorage,
                    })

                    const handlerContext: AppRouteHandlerFnContext = {
                      params: context.params
                        ? createServerParamsForRoute(
                            parsedUrlQueryToParams(context.params),
                            workStore
                          )
                        : undefined,
                    }

                    let res
                    if (isStaticGeneration && dynamicIOEnabled) {
                      /**
                       * When we are attempting to statically prerender the GET handler of a route.ts module
                       * and dynamicIO is on we follow a similar pattern to rendering.
                       *
                       * We first run the handler letting caches fill. If something synchronously dynamic occurs
                       * during this prospective render then we can infer it will happen on every render and we
                       * just bail out of prerendering.
                       *
                       * Next we run the handler again and we check if we get a result back in a microtask.
                       * Next.js expects the return value to be a Response or a Thenable that resolves to a Response.
                       * Unfortunately Response's do not allow for acessing the response body synchronously or in
                       * a microtask so we need to allow one more task to unwrap the response body. This is a slightly
                       * different semantic than what we have when we render and it means that certain tasks can still
                       * execute before a prerender completes such as a carefully timed setImmediate.
                       *
                       * Functionally though IO should still take longer than the time it takes to unwrap the response body
                       * so our heuristic of excluding any IO should be preserved.
                       */
                      let prospectiveRenderIsDynamic = false
                      const cacheSignal = new CacheSignal()
                      let dynamicTracking =
                        createDynamicTrackingState(undefined)
                      const prospectiveRoutePrerenderStore: PrerenderStore = {
                        cacheSignal,
                        // During prospective render we don't use a controller
                        // because we need to let all caches fill.
                        controller: null,
                        dynamicTracking,
                      }
                      let prospectiveResult
                      try {
                        prospectiveResult = this.prerenderAsyncStorage.run(
                          prospectiveRoutePrerenderStore,
                          handler,
                          request,
                          handlerContext
                        )
                      } catch (err) {
                        if (isPrerenderInterruptedError(err)) {
                          // the route handler called an API which is always dynamic
                          // there is no need to try again
                          prospectiveRenderIsDynamic = true
                        }
                      }
                      if (
                        typeof prospectiveResult === 'object' &&
                        prospectiveResult !== null &&
                        typeof (prospectiveResult as any).then === 'function'
                      ) {
                        // The handler returned a Thenable. We'll listen for rejections to determine
                        // if the route is erroring for dynamic reasons.
                        ;(prospectiveResult as any as Promise<unknown>).then(
                          () => {},
                          (err) => {
                            if (isPrerenderInterruptedError(err)) {
                              // the route handler called an API which is always dynamic
                              // there is no need to try again
                              prospectiveRenderIsDynamic = true
                            }
                          }
                        )
                      }
                      await cacheSignal.cacheReady()

                      if (prospectiveRenderIsDynamic) {
                        // the route handler called an API which is always dynamic
                        // there is no need to try again
                        const dynamicReason =
                          getFirstDynamicReason(dynamicTracking)
                        if (dynamicReason) {
                          throw new DynamicServerError(
                            `Route ${workStore.route} couldn't be rendered statically because it used \`${dynamicReason}\`. See more info here: https://nextjs.org/docs/messages/dynamic-server-error`
                          )
                        } else {
                          console.error(
                            'Expected Next.js to keep track of reason for opting out of static rendering but one was not found. This is a bug in Next.js'
                          )
                          throw new DynamicServerError(
                            `Route ${workStore.route} couldn't be rendered statically because it used a dynamic API. See more info here: https://nextjs.org/docs/messages/dynamic-server-error`
                          )
                        }
                      }

                      // TODO start passing this controller to the route handler. We should expose
                      // it so the handler to abort inflight requests and other operations if we abort
                      // the prerender.
                      const controller = new AbortController()
                      dynamicTracking = createDynamicTrackingState(undefined)

                      const finalRoutePrerenderStore: PrerenderStore = {
                        cacheSignal: null,
                        controller,
                        dynamicTracking,
                      }

                      let responseHandled = false
                      res = await new Promise((resolve, reject) => {
                        scheduleImmediate(async () => {
                          try {
                            const result =
                              await (this.prerenderAsyncStorage.run(
                                finalRoutePrerenderStore,
                                handler,
                                request,
                                handlerContext
                              ) as Promise<Response>)
                            if (responseHandled) {
                              // we already rejected in the followup task
                              return
                            } else if (!(result instanceof Response)) {
                              // This is going to error but we let that happen below
                              resolve(result)
                              return
                            }

                            responseHandled = true

                            let bodyHandled = false
                            result.arrayBuffer().then((body) => {
                              if (!bodyHandled) {
                                bodyHandled = true

                                resolve(
                                  new Response(body, {
                                    headers: result.headers,
                                    status: result.status,
                                    statusText: result.statusText,
                                  })
                                )
                              }
                            }, reject)
                            scheduleImmediate(() => {
                              if (!bodyHandled) {
                                bodyHandled = true
                                controller.abort()
                                reject(createDynamicIOError(workStore.route))
                              }
                            })
                          } catch (err) {
                            reject(err)
                          }
                        })
                        scheduleImmediate(() => {
                          if (!responseHandled) {
                            responseHandled = true
                            controller.abort()
                            reject(createDynamicIOError(workStore.route))
                          }
                        })
                      })
                    } else {
                      res = await handler(request, handlerContext)
                    }
                    if (!(res instanceof Response)) {
                      throw new Error(
                        `No response is returned from route handler '${this.resolvedPagePath}'. Ensure you return a \`Response\` or a \`NextResponse\` in all branches of your handler.`
                      )
                    }
                    context.renderOpts.fetchMetrics = workStore.fetchMetrics

                    context.renderOpts.pendingWaitUntil = Promise.all([
                      workStore.incrementalCache?.revalidateTag(
                        workStore.revalidatedTags || []
                      ),
                      ...Object.values(workStore.pendingRevalidates || {}),
                    ])

                    addImplicitTags(workStore, requestStore)
                    ;(context.renderOpts as any).fetchTags =
                      workStore.tags?.join(',')

                    // It's possible cookies were set in the handler, so we need
                    // to merge the modified cookies and the returned response
                    // here.
                    if (requestStore && requestStore.mutableCookies) {
                      const headers = new Headers(res.headers)
                      if (
                        appendMutableCookies(
                          headers,
                          requestStore.mutableCookies
                        )
                      ) {
                        return new Response(res.body, {
                          status: res.status,
                          statusText: res.statusText,
                          headers,
                        })
                      }
                    }

                    return res
                  }
                )
              }
            )
        )
    )

    // If the handler did't return a valid response, then return the internal
    // error response.
    if (!(response instanceof Response)) {
      // TODO: validate the correct handling behavior, maybe log something?
      return handleInternalServerErrorResponse()
    }

    if (response.headers.has('x-middleware-rewrite')) {
      // TODO: move this error into the `NextResponse.rewrite()` function.
      // TODO-APP: re-enable support below when we can proxy these type of requests
      throw new Error(
        'NextResponse.rewrite() was used in a app route handler, this is not currently supported. Please remove the invocation to continue.'
      )

      // // This is a rewrite created via `NextResponse.rewrite()`. We need to send
      // // the response up so it can be handled by the backing server.

      // // If the server is running in minimal mode, we just want to forward the
      // // response (including the rewrite headers) upstream so it can perform the
      // // redirect for us, otherwise return with the special condition so this
      // // server can perform a rewrite.
      // if (!minimalMode) {
      //   return { response, condition: 'rewrite' }
      // }

      // // Relativize the url so it's relative to the base url. This is so the
      // // outgoing headers upstream can be relative.
      // const rewritePath = response.headers.get('x-middleware-rewrite')!
      // const initUrl = getRequestMeta(req, 'initURL')!
      // const { pathname } = parseUrl(relativizeURL(rewritePath, initUrl))
      // response.headers.set('x-middleware-rewrite', pathname)
    }

    if (response.headers.get('x-middleware-next') === '1') {
      // TODO: move this error into the `NextResponse.next()` function.
      throw new Error(
        'NextResponse.next() was used in a app route handler, this is not supported. See here for more info: https://nextjs.org/docs/messages/next-response-next-in-app-route-handler'
      )
    }

    return response
  }

  public async handle(
    request: NextRequest,
    context: AppRouteRouteHandlerContext
  ): Promise<Response> {
    try {
      // Execute the route to get the response.
      const response = await this.execute(request, context)

      // The response was handled, return it.
      return response
    } catch (err) {
      // Try to resolve the error to a response, else throw it again.
      const response = resolveHandlerError(err)
      if (!response) throw err

      // The response was resolved, return it.
      return response
    }
  }
}

export default AppRouteRouteModule

/**
 * Gets all the method names for handlers that are not considered static.
 *
 * @param handlers the handlers from the userland module
 * @returns the method names that are not considered static or false if all
 *          methods are static
 */
export function hasNonStaticMethods(handlers: AppRouteHandlers): boolean {
  if (
    // Order these by how common they are to be used
    handlers.POST ||
    handlers.PUT ||
    handlers.DELETE ||
    handlers.PATCH ||
    handlers.OPTIONS
  ) {
    return true
  }
  return false
}

// These symbols will be used to stash cached values on Proxied requests without requiring
// additional closures or storage such as WeakMaps.
const nextURLSymbol = Symbol('nextUrl')
const requestCloneSymbol = Symbol('clone')
const urlCloneSymbol = Symbol('clone')
const searchParamsSymbol = Symbol('searchParams')
const hrefSymbol = Symbol('href')
const toStringSymbol = Symbol('toString')
const headersSymbol = Symbol('headers')
const cookiesSymbol = Symbol('cookies')

type RequestSymbolTarget = {
  [headersSymbol]?: Headers
  [cookiesSymbol]?: RequestCookies | ReadonlyRequestCookies
  [nextURLSymbol]?: NextURL
  [requestCloneSymbol]?: () => NextRequest
}

type UrlSymbolTarget = {
  [searchParamsSymbol]?: URLSearchParams
  [hrefSymbol]?: string
  [toStringSymbol]?: () => string
  [urlCloneSymbol]?: () => NextURL
}

/**
 * The general technique with these proxy handlers is to prioritize keeping them static
 * by stashing computed values on the Proxy itself. This is safe because the Proxy is
 * inaccessible to the consumer since all operations are forwarded
 */
const forceStaticRequestHandlers = {
  get(
    target: NextRequest & RequestSymbolTarget,
    prop: string | symbol,
    receiver: any
  ): unknown {
    switch (prop) {
      case 'headers':
        return (
          target[headersSymbol] ||
          (target[headersSymbol] = HeadersAdapter.seal(new Headers({})))
        )
      case 'cookies':
        return (
          target[cookiesSymbol] ||
          (target[cookiesSymbol] = RequestCookiesAdapter.seal(
            new RequestCookies(new Headers({}))
          ))
        )
      case 'nextUrl':
        return (
          target[nextURLSymbol] ||
          (target[nextURLSymbol] = new Proxy(
            target.nextUrl,
            forceStaticNextUrlHandlers
          ))
        )
      case 'url':
        // we don't need to separately cache this we can just read the nextUrl
        // and return the href since we know it will have been stripped of any
        // dynamic parts. We access via the receiver to trigger the get trap
        return receiver.nextUrl.href
      case 'geo':
      case 'ip':
        return undefined
      case 'clone':
        return (
          target[requestCloneSymbol] ||
          (target[requestCloneSymbol] = () =>
            new Proxy(
              // This is vaguely unsafe but it's required since NextRequest does not implement
              // clone. The reason we might expect this to work in this context is the Proxy will
              // respond with static-amenable values anyway somewhat restoring the interface.
              // @TODO we need to rethink NextRequest and NextURL because they are not sufficientlly
              // sophisticated to adequately represent themselves in all contexts. A better approach is
              // to probably embed the static generation logic into the class itself removing the need
              // for any kind of proxying
              target.clone() as NextRequest,
              forceStaticRequestHandlers
            ))
        )
      default:
        return ReflectAdapter.get(target, prop, receiver)
    }
  },
  // We don't need to proxy set because all the properties we proxy are ready only
  // and will be ignored
}

const forceStaticNextUrlHandlers = {
  get(
    target: NextURL & UrlSymbolTarget,
    prop: string | symbol,
    receiver: any
  ): unknown {
    switch (prop) {
      // URL properties
      case 'search':
        return ''
      case 'searchParams':
        return (
          target[searchParamsSymbol] ||
          (target[searchParamsSymbol] = new URLSearchParams())
        )
      case 'href':
        return (
          target[hrefSymbol] ||
          (target[hrefSymbol] = cleanURL(target.href).href)
        )
      case 'toJSON':
      case 'toString':
        return (
          target[toStringSymbol] ||
          (target[toStringSymbol] = () => receiver.href)
        )

      // NextUrl properties
      case 'url':
        // Currently nextURL does not expose url but our Docs indicate that it is an available property
        // I am forcing this to undefined here to avoid accidentally exposing a dynamic value later if
        // the underlying nextURL ends up adding this property
        return undefined
      case 'clone':
        return (
          target[urlCloneSymbol] ||
          (target[urlCloneSymbol] = () =>
            new Proxy(target.clone(), forceStaticNextUrlHandlers))
        )
      default:
        return ReflectAdapter.get(target, prop, receiver)
    }
  },
}

function proxyNextRequest(request: NextRequest, workStore: WorkStore) {
  const nextUrlHandlers = {
    get(
      target: NextURL & UrlSymbolTarget,
      prop: string | symbol,
      receiver: any
    ): unknown {
      switch (prop) {
        case 'search':
        case 'searchParams':
        case 'url':
        case 'href':
        case 'toJSON':
        case 'toString':
        case 'origin': {
          trackDynamicDataAccessed(workStore, `nextUrl.${prop}`)
          return ReflectAdapter.get(target, prop, receiver)
        }
        case 'clone':
          return (
            target[urlCloneSymbol] ||
            (target[urlCloneSymbol] = () =>
              new Proxy(target.clone(), nextUrlHandlers))
          )
        default:
          return ReflectAdapter.get(target, prop, receiver)
      }
    },
  }

  const nextRequestHandlers = {
    get(
      target: NextRequest & RequestSymbolTarget,
      prop: string | symbol
    ): unknown {
      switch (prop) {
        case 'nextUrl':
          return (
            target[nextURLSymbol] ||
            (target[nextURLSymbol] = new Proxy(target.nextUrl, nextUrlHandlers))
          )
        case 'headers':
        case 'cookies':
        case 'url':
        case 'body':
        case 'blob':
        case 'json':
        case 'text':
        case 'arrayBuffer':
        case 'formData': {
          trackDynamicDataAccessed(workStore, `request.${prop}`)
          // The receiver arg is intentionally the same as the target to fix an issue with
          // edge runtime, where attempting to access internal slots with the wrong `this` context
          // results in an error.
          return ReflectAdapter.get(target, prop, target)
        }
        case 'clone':
          return (
            target[requestCloneSymbol] ||
            (target[requestCloneSymbol] = () =>
              new Proxy(
                // This is vaguely unsafe but it's required since NextRequest does not implement
                // clone. The reason we might expect this to work in this context is the Proxy will
                // respond with static-amenable values anyway somewhat restoring the interface.
                // @TODO we need to rethink NextRequest and NextURL because they are not sufficientlly
                // sophisticated to adequately represent themselves in all contexts. A better approach is
                // to probably embed the static generation logic into the class itself removing the need
                // for any kind of proxying
                target.clone() as NextRequest,
                nextRequestHandlers
              ))
          )
        default:
          // The receiver arg is intentionally the same as the target to fix an issue with
          // edge runtime, where attempting to access internal slots with the wrong `this` context
          // results in an error.
          return ReflectAdapter.get(target, prop, target)
      }
    },
    // We don't need to proxy set because all the properties we proxy are ready only
    // and will be ignored
  }

  return new Proxy(request, nextRequestHandlers)
}

const requireStaticRequestHandlers = {
  get(
    target: NextRequest & RequestSymbolTarget,
    prop: string | symbol,
    receiver: any
  ): unknown {
    switch (prop) {
      case 'nextUrl':
        return (
          target[nextURLSymbol] ||
          (target[nextURLSymbol] = new Proxy(
            target.nextUrl,
            requireStaticNextUrlHandlers
          ))
        )
      case 'headers':
      case 'cookies':
      case 'url':
      case 'body':
      case 'blob':
      case 'json':
      case 'text':
      case 'arrayBuffer':
      case 'formData':
        throw new StaticGenBailoutError(
          `Route ${target.nextUrl.pathname} with \`dynamic = "error"\` couldn't be rendered statically because it used \`request.${prop}\`.`
        )
      case 'clone':
        return (
          target[requestCloneSymbol] ||
          (target[requestCloneSymbol] = () =>
            new Proxy(
              // This is vaguely unsafe but it's required since NextRequest does not implement
              // clone. The reason we might expect this to work in this context is the Proxy will
              // respond with static-amenable values anyway somewhat restoring the interface.
              // @TODO we need to rethink NextRequest and NextURL because they are not sufficientlly
              // sophisticated to adequately represent themselves in all contexts. A better approach is
              // to probably embed the static generation logic into the class itself removing the need
              // for any kind of proxying
              target.clone() as NextRequest,
              requireStaticRequestHandlers
            ))
        )
      default:
        return ReflectAdapter.get(target, prop, receiver)
    }
  },
  // We don't need to proxy set because all the properties we proxy are ready only
  // and will be ignored
}

const requireStaticNextUrlHandlers = {
  get(
    target: NextURL & UrlSymbolTarget,
    prop: string | symbol,
    receiver: any
  ): unknown {
    switch (prop) {
      case 'search':
      case 'searchParams':
      case 'url':
      case 'href':
      case 'toJSON':
      case 'toString':
      case 'origin':
        throw new StaticGenBailoutError(
          `Route ${target.pathname} with \`dynamic = "error"\` couldn't be rendered statically because it used \`nextUrl.${prop}\`.`
        )
      case 'clone':
        return (
          target[urlCloneSymbol] ||
          (target[urlCloneSymbol] = () =>
            new Proxy(target.clone(), requireStaticNextUrlHandlers))
        )
      default:
        return ReflectAdapter.get(target, prop, receiver)
    }
  },
}

function createDynamicIOError(route: string) {
  return new DynamicServerError(
    `Route ${route} couldn't be rendered statically because it used IO that was not cached. See more info here: https://nextjs.org/docs/messages/dynamic-io`
  )
}
