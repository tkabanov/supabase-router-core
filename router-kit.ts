import type {
  AuthOptions,
  EmptyObject,
  RouteBodyOf,
  RouteContext,
  RouteDef,
  RouteDefinitionInput,
  RouteParamsOf,
  RouteQueryOf,
  Router,
  RouterConfig,
  RouteSchemaDefinition,
  ServiceContainer,
  UserOnlyAuthOptions,
} from "./core/types.ts";
import { defineRoute, defineRouter } from "./router.ts";

/**
 * Types of an application, bound once with {@link createRouterKit}.
 * Every field is optional; omitted ones fall back to the package defaults.
 */
export interface AppTypes {
  /** Role type used by `allowedRoles` */
  role?: unknown;
  /** User type (`ctx.user`) */
  user?: unknown;
  /** Service container type (`ctx.services`) */
  container?: ServiceContainer;
  /** Extra `authentication` fields understood by a custom auth handler */
  authOptions?: object;
  /** Type of `AuthResult.data` / `ctx.auth.data` */
  authData?: unknown;
}

/** Role type of an {@link AppTypes} */
export type RoleOf<T extends AppTypes> = T extends { role: infer R } ? R
  : string;
/** User type of an {@link AppTypes} */
export type UserOf<T extends AppTypes> = T extends { user: infer U } ? U
  : unknown;
/** Container type of an {@link AppTypes} */
export type ContainerOf<T extends AppTypes> = T extends
  { container: infer C extends ServiceContainer } ? C : ServiceContainer;
/** Extra authentication options of an {@link AppTypes} */
export type AuthExtOf<T extends AppTypes> = T extends
  { authOptions: infer E extends object } ? E : EmptyObject;
/** Auth data type of an {@link AppTypes} */
export type AuthDataOf<T extends AppTypes> = T extends { authData: infer D } ? D
  : unknown;

/** Shallow merge with the same precedence as the runtime (`R` wins) */
export type MergeAuthOptions<D, R> = Omit<D, keyof R> & R;

/** `authentication` accepted by routes of an app */
export type AppAuthOptions<T extends AppTypes> = AuthOptions<
  RoleOf<T>,
  AuthExtOf<T>
>;

/** Router-level authentication defaults (anything but `allowedMethods`) */
export type AppAuthDefaults<T extends AppTypes> = Omit<
  AppAuthOptions<T>,
  "allowedMethods"
>;

/**
 * Context type for authenticated handlers declared outside `defineRoute`,
 * e.g. in a separate file.
 * @template T - Application types
 * @template TSchema - `typeof requestSchema`
 * @template TAuthOpts - Effective `authentication` (after router defaults)
 *
 * @example
 * ```typescript
 * const schema = { params: z.object({ id: z.string() }) };
 * export const getItem = (ctx: HandlerContext<App, typeof schema>) =>
 *   loadItem(ctx.supabaseClient, ctx.params.id, ctx.user);
 * ```
 */
export type HandlerContext<
  T extends AppTypes,
  TSchema extends RouteSchemaDefinition | undefined = undefined,
  TAuthOpts = UserOnlyAuthOptions<RoleOf<T>, AuthExtOf<T>>,
> = RouteContext<
  RouteParamsOf<TSchema>,
  RouteQueryOf<TSchema>,
  RouteBodyOf<TSchema>,
  true,
  UserOf<T>,
  ContainerOf<T>,
  TAuthOpts,
  AuthDataOf<T>
>;

/** Context type for public (`authRequired: false`) handlers declared separately */
export type PublicHandlerContext<
  T extends AppTypes,
  TSchema extends RouteSchemaDefinition | undefined = undefined,
> = RouteContext<
  RouteParamsOf<TSchema>,
  RouteQueryOf<TSchema>,
  RouteBodyOf<TSchema>,
  false,
  UserOf<T>,
  ContainerOf<T>
>;

/** Route definition input of a kit: `authentication` is the route's own part */
export type KitRouteInput<
  T extends AppTypes,
  D,
  TSchema extends RouteSchemaDefinition | undefined,
  TAuth extends boolean,
  TAuthOpts,
> =
  & Omit<
    RouteDefinitionInput<
      RoleOf<T>,
      UserOf<T>,
      TSchema,
      TAuth,
      RouteParamsOf<TSchema>,
      RouteQueryOf<TSchema>,
      RouteBodyOf<TSchema>,
      ContainerOf<T>,
      MergeAuthOptions<D, TAuthOpts>,
      AuthDataOf<T>
    >,
    "authentication"
  >
  & { authentication?: TAuthOpts };

/** Route definition produced by a kit */
export type KitRouteDef<
  T extends AppTypes,
  D,
  TSchema extends RouteSchemaDefinition | undefined,
  TAuth extends boolean,
  TAuthOpts,
> = RouteDef<
  RoleOf<T>,
  UserOf<T>,
  RouteParamsOf<TSchema>,
  RouteQueryOf<TSchema>,
  RouteBodyOf<TSchema>,
  TAuth,
  ContainerOf<T>,
  MergeAuthOptions<D, TAuthOpts>,
  AuthDataOf<T>
>;

/** Router configuration of a kit */
export type KitRouterConfig<T extends AppTypes> = RouterConfig<
  RoleOf<T>,
  UserOf<T>,
  ContainerOf<T>,
  AuthExtOf<T>,
  AuthDataOf<T>
>;

/** `defineRoute` / `defineRouter` bound to an app's types and defaults */
export interface BoundRouterKit<T extends AppTypes, D> {
  /** `defineRoute` with the app's types; `ctx.auth` reflects the defaults */
  defineRoute<
    TSchema extends RouteSchemaDefinition | undefined = undefined,
    TAuth extends boolean = true,
    const TAuthOpts extends Partial<AppAuthOptions<T>> = EmptyObject,
  >(
    def: KitRouteInput<T, D, TSchema, TAuth, TAuthOpts>,
    // NoInfer: otherwise both are inferred from the router's routes array
  ): KitRouteDef<T, D, TSchema, NoInfer<TAuth>, NoInfer<TAuthOpts>>;
  /** `defineRouter` with the app's types; applies the kit's defaults */
  defineRouter(config: KitRouterConfig<T>): Router;
}

/** Router kit bound to an app's types */
export interface RouterKit<T extends AppTypes>
  extends BoundRouterKit<T, EmptyObject> {
  /**
   * A kit whose routers apply `defaults` to every authenticated route and
   * whose `defineRoute` knows about them, so `ctx.auth` / `ctx.user` are
   * typed from the merged options. Use one per router with such defaults.
   *
   * @example
   * ```typescript
   * const service = kit.withAuthDefaults({ requireServiceRole: true });
   * export const router = service.defineRouter({
   *   basePath: "/task-manager",
   *   routes: [service.defineRoute({ ... })], // ctx.auth.kind is "service"
   * });
   * ```
   */
  withAuthDefaults<const D extends AppAuthDefaults<T>>(
    defaults: D,
  ): BoundRouterKit<T, D>;
}

const bindKit = <T extends AppTypes, D>(
  defaults: D | undefined,
): BoundRouterKit<T, D> => ({
  defineRoute: (def) => defineRoute(def as never) as never,
  defineRouter: (config) =>
    defineRouter({
      ...config,
      // The kit's defaults may contain caller-kind flags: route types know
      // about them, which is what makes them safe here
      defaultAuthentication: {
        ...defaults,
        ...config.defaultAuthentication,
      },
    } as never),
});

/**
 * Bind `defineRoute` / `defineRouter` to an application's types once, instead
 * of repeating up to eight generic parameters.
 * @template T - Application types
 * @returns Router kit
 *
 * @example
 * ```typescript
 * const kit = createRouterKit<{
 *   role: Role;
 *   user: AppUser;
 *   authOptions: { freshUser?: boolean };
 * }>();
 *
 * export const { defineRoute, defineRouter } = kit;
 * ```
 */
export function createRouterKit<T extends AppTypes = AppTypes>(): RouterKit<
  T
> {
  return {
    ...bindKit<T, EmptyObject>(undefined),
    withAuthDefaults: <const D extends AppAuthDefaults<T>>(defaults: D) =>
      bindKit<T, D>(defaults),
  };
}
