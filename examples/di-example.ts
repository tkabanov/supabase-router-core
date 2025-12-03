/**
 * Dependency Injection Example
 *
 * This example demonstrates how to inject custom services into your router
 * for better testability and separation of concerns.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createContainer, defineRoute, defineRouter } from "../mod.ts";
import type { ServiceContainer } from "../mod.ts";
import { z } from "npm:zod";

// ============================================================================
// 1. Define Custom Services
// ============================================================================

/**
 * Custom email service interface
 */
interface EmailService {
  sendWelcomeEmail(email: string, name: string): Promise<void>;
  sendPasswordResetEmail(email: string, resetToken: string): Promise<void>;
}

/**
 * Production email service implementation
 */
class ProductionEmailService implements EmailService {
  async sendWelcomeEmail(email: string, name: string): Promise<void> {
    console.log(`Sending welcome email to ${email} (${name})`);
    // In production: integrate with SendGrid, AWS SES, etc.
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("SENDGRID_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: "noreply@example.com" },
        subject: "Welcome!",
        content: [{ type: "text/plain", value: `Welcome ${name}!` }],
      }),
    });
  }

  sendPasswordResetEmail(email: string, resetToken: string): Promise<void> {
    console.log(`Sending password reset to ${email} with token ${resetToken}`);
    // Implementation here...
    return Promise.resolve();
  }
}

/**
 * Custom analytics service interface
 */
interface AnalyticsService {
  trackEvent(
    userId: string,
    event: string,
    properties?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Production analytics service implementation
 */
class ProductionAnalyticsService implements AnalyticsService {
  trackEvent(
    userId: string,
    event: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    console.log(`Analytics: ${userId} - ${event}`, properties);
    // In production: integrate with Mixpanel, Amplitude, etc.
    return Promise.resolve();
  }
}

/**
 * Custom payment service interface
 */
interface PaymentService {
  createCheckoutSession(
    userId: string,
    priceId: string,
  ): Promise<{ sessionId: string; url: string }>;
  verifyPayment(sessionId: string): Promise<boolean>;
}

/**
 * Production payment service implementation (Stripe)
 */
class StripePaymentService implements PaymentService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  createCheckoutSession(
    userId: string,
    priceId: string,
  ): Promise<{ sessionId: string; url: string }> {
    console.log(
      `Creating checkout session for user ${userId} and price ${priceId}`,
    );
    // In production: use Stripe SDK
    return Promise.resolve({
      sessionId: "cs_test_123",
      url: "https://checkout.stripe.com/pay/cs_test_123",
    });
  }

  verifyPayment(sessionId: string): Promise<boolean> {
    console.log(`Verifying payment ${sessionId}`);
    return Promise.resolve(true);
  }
}

// ============================================================================
// 2. Extend ServiceContainer with Custom Services
// ============================================================================

interface CustomServices extends ServiceContainer {
  emailService: EmailService;
  analyticsService: AnalyticsService;
  paymentService: PaymentService;
}

// ============================================================================
// 3. Create Router with Custom Services
// ============================================================================

// Role system
enum AppRoles {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

interface AppUser {
  id: string;
  email: string;
  name: string;
  role: AppRoles;
}

// Request schemas
const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
});

const createCheckoutSchema = z.object({
  priceId: z.string(),
});

// Create container with custom services
const container: CustomServices = createContainer({
  // Add custom services
  emailService: new ProductionEmailService(),
  analyticsService: new ProductionAnalyticsService(),
  paymentService: new StripePaymentService(
    Deno.env.get("STRIPE_API_KEY") || "sk_test_...",
  ),
  // Can also override built-in services if needed
  // logger: customLogger,
  // idGenerator: customIdGenerator,
}) as CustomServices;

// Define router
export const router = defineRouter<AppRoles, AppUser>({
  basePath: "/api",
  defaultTags: ["API"],

  // Inject custom services
  container,

  routes: [
    // ====================================================================
    // Example 1: Using EmailService in handler
    // ====================================================================
    defineRoute({
      method: "POST",
      path: "/auth/register",
      summary: "Register new user",
      authRequired: false,
      requestSchema: {
        body: registerSchema,
      },
      handler: async ({ body, services }) => {
        const { email, name } = body;

        // Access custom service via services container
        const customServices = services as CustomServices;

        // Create user (simplified)
        const userId = crypto.randomUUID();

        // Send welcome email using injected service
        await customServices.emailService.sendWelcomeEmail(email, name);

        // Track registration event
        await customServices.analyticsService.trackEvent(
          userId,
          "user_registered",
          {
            email,
            source: "web",
          },
        );

        return {
          success: true,
          userId,
          message: "Registration successful. Check your email!",
        };
      },
    }),

    // ====================================================================
    // Example 2: Using Multiple Services
    // ====================================================================
    defineRoute({
      method: "POST",
      path: "/payments/checkout",
      summary: "Create checkout session",
      authRequired: true,
      allowedRoles: [AppRoles.USER, AppRoles.ADMIN],
      requestSchema: {
        body: createCheckoutSchema,
      },
      handler: async ({ body, user, services }) => {
        const customServices = services as CustomServices;

        // Create Stripe checkout session
        const session = await customServices.paymentService
          .createCheckoutSession(
            user.id,
            body.priceId,
          );

        // Track checkout started
        await customServices.analyticsService.trackEvent(
          user.id,
          "checkout_started",
          {
            priceId: body.priceId,
            sessionId: session.sessionId,
          },
        );

        // Log with injected logger
        services.logger.log(`Checkout session created for user ${user.id}`);

        return {
          sessionId: session.sessionId,
          checkoutUrl: session.url,
        };
      },
    }),

    // ====================================================================
    // Example 3: Password Reset with EmailService
    // ====================================================================
    defineRoute({
      method: "POST",
      path: "/auth/forgot-password",
      summary: "Request password reset",
      authRequired: false,
      requestSchema: {
        body: z.object({
          email: z.string().email(),
        }),
      },
      handler: async ({ body, services }) => {
        const customServices = services as CustomServices;

        // Generate reset token
        const resetToken = services.idGenerator.generate();

        // Send password reset email
        await customServices.emailService.sendPasswordResetEmail(
          body.email,
          resetToken,
        );

        // Track event
        await customServices.analyticsService.trackEvent(
          body.email,
          "password_reset_requested",
        );

        return {
          success: true,
          message: "If the email exists, a reset link has been sent.",
        };
      },
    }),

    // ====================================================================
    // Example 4: Admin Analytics Dashboard
    // ====================================================================
    defineRoute({
      method: "GET",
      path: "/admin/analytics",
      summary: "Get analytics summary",
      authRequired: true,
      allowedRoles: [AppRoles.ADMIN],
      handler: async ({ user, services }) => {
        const customServices = services as CustomServices;

        services.logger.log(`Admin ${user.email} accessing analytics`);

        // Track admin action
        await customServices.analyticsService.trackEvent(
          user.id,
          "admin_view_analytics",
        );

        // Return analytics data
        return {
          totalUsers: 1234,
          activeUsers: 567,
          revenue: 98765,
          lastUpdated: new Date().toISOString(),
        };
      },
    }),
  ],
});

// ============================================================================
// 4. For Testing: Mock Services
// ============================================================================

/**
 * Create a test container with mocked services
 */
export function createTestContainer(): CustomServices {
  return createContainer({
    // Mock email service
    emailService: {
      sendWelcomeEmail: (email: string, name: string) => {
        console.log(`[TEST] Welcome email to ${email} for ${name}`);
        return Promise.resolve();
      },
      sendPasswordResetEmail: (email: string, token: string) => {
        console.log(`[TEST] Reset email to ${email} with token ${token}`);
        return Promise.resolve();
      },
    },

    // Mock analytics service
    analyticsService: {
      trackEvent: (
        userId: string,
        event: string,
        properties?: Record<string, unknown>,
      ) => {
        console.log(`[TEST] Event: ${event}`, { userId, properties });
        return Promise.resolve();
      },
    },

    // Mock payment service
    paymentService: {
      createCheckoutSession: (userId: string, priceId: string) =>
        Promise.resolve({
          sessionId: `test_session_${userId}_${priceId}`,
          url: "https://test.stripe.com/checkout",
        }),
      verifyPayment: (sessionId: string) =>
        Promise.resolve(sessionId.startsWith("test_session_")),
    },

    // Silent logger for tests
    logger: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
  }) as CustomServices;
}

// ============================================================================
// 5. Standalone Execution
// ============================================================================

if (import.meta.main) {
  console.log("Starting DI example server with custom services...");
  console.log("Available endpoints:");
  console.log("  POST /api/auth/register");
  console.log("  POST /api/payments/checkout");
  console.log("  POST /api/auth/forgot-password");
  console.log("  GET  /api/admin/analytics");

  Deno.serve(router.handler);
}
