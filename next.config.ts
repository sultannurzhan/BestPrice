import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Scraping happens in route handlers; nothing to prerender.
  experimental: {
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
