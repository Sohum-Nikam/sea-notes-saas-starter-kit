// NextAuth imports
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import MicrosoftEntraId from 'next-auth/providers/microsoft-entra-id';
import type { Provider } from 'next-auth/providers';

// Database service imports
import { createDatabaseService } from 'services/database/databaseFactory';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '../prisma';

// Helper imports
import { verifyPassword } from 'helpers/hash';
import { User, UserRole } from 'types';
import { InvalidCredentialsError } from './errors';
import { serverConfig } from 'settings';

/**
 * Type guard to check if user object has role property
 * This helps us safely access the role property on user objects
 */
const hasRole = (user: unknown): user is { id: string; role: UserRole } => {
  return typeof user === 'object' && user !== null && 'role' in user && 'id' in user;
};

/**
 * Verify magic link token
 * Checks if the token is valid and not expired
 * Deletes the token after verification
 */
const verifyMagicLinkToken = async (token: string, email: string) => {
  const db = await createDatabaseService();

  const verification = await db.verificationToken.find(email, token);
  if (!verification || verification.expires < new Date()) {
    if (verification) {
      await db.verificationToken.delete(email, token);
    }

    throw new Error('Invalid or expired token');
  }

  await db.verificationToken.delete(email, token);

  return true;
};

/**
 * Authentication providers configuration
 * We support Google, GitHub, Microsoft, and email/password credentials
 */
const providers: Provider[] = [
  // Google OAuth Provider
  Google({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    allowDangerousEmailAccountLinking: true,
  }),
  
  // GitHub OAuth Provider
  GitHub({
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    allowDangerousEmailAccountLinking: true,
  }),
  
  // Microsoft OAuth Provider
  MicrosoftEntraId({
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    issuer: process.env.MICROSOFT_ISSUER,
    allowDangerousEmailAccountLinking: true,
  }),
  
  // Credentials Provider (email/password)
  Credentials({
    credentials: {
      email: {},
      password: {},
      magicLinkToken: {},
    },
    authorize: async (credentials) => {
      try {
        const dbClient = await createDatabaseService();
        
        // Handle magic link authentication
        if (credentials.magicLinkToken && credentials.email) {
          await verifyMagicLinkToken(
            credentials.magicLinkToken as string,
            credentials.email as string
          );
          const user = await dbClient.user.findByEmail(credentials.email as string);
          if (!user) {
            throw new Error('User not found');
          }
          return user;
        }

        // Handle regular email/password authentication
        if (!credentials.email || !credentials.password) {
          throw new Error('Email and password are required');
        }

        const user = await dbClient.user.findByEmail(credentials.email as string);
        if (!user || !user.passwordHash) {
          throw new Error('User not found or password hash is missing');
        }

        // Check if email is verified (if email integration is enabled)
        if (user.emailVerified === false && serverConfig.enableEmailIntegration) {
          throw new Error('Email not verified');
        }

        // Verify password
        const isValid = await verifyPassword(credentials.password as string, user.passwordHash);
        if (!isValid) {
          throw new Error('Invalid credentials');
        }

        return user;
      } catch (error) {
        throw new InvalidCredentialsError((error as Error).message);
      }
    },
  }),
];

// Set the auth URL to our base URL
process.env.AUTH_URL = process.env.BASE_URL;

// Export the NextAuth handlers, signIn, signOut, and auth functions
export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  secret: process.env.AUTH_SECRET,
  providers,
  callbacks: {
    /**
     * JWT callback - called whenever a JWT is created or updated
     * We add custom properties like id, role, email, and name to the token
     */
    async jwt({ token, user, trigger, session }) {
      if (user && hasRole(user)) {
        token.id = user.id;
        token.role = (user as User).role;
        token.email = (user as User).email;
        token.name = (user as User).name;
      }

      // Handle session updates
      if (trigger === 'update') {
        token.image = session.user.image;
        token.name = session.user.name;
      }

      return token;
    },
    
    /**
     * Session callback - called whenever a session is checked
     * We add custom properties from the token to the session
     */
    async session({ session, token }) {
      if (token && hasRole(token)) {
        session.user.id = token.id as string;
        session.user.role = token.role as UserRole;
      }

      session.user.email = token.email as string;

      if (token.image) {
        session.user.image = token.image as string;
      }

      if (token.name) {
        session.user.name = token.name as string;
      }

      return session;
    },
  },
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
    signOut: '/logout',
    newUser: '/signup',
  },
});