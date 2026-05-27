/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Analyze runs both PSI calls + a Claude call; give it room.
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
