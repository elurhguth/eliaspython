/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the app is served by Caddy next to the API – no Node server needed.
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};
export default nextConfig;
