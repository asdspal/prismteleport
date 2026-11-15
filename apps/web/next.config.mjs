/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mezo Passport ships TypeScript sources inside its dependency chain
  // (@mezo-org/orangekit-smart-account), so Next must transpile them.
  transpilePackages: [
    "@mezo-org/passport",
    "@mezo-org/orangekit",
    "@mezo-org/orangekit-contracts",
    "@mezo-org/orangekit-smart-account",
    "@mezo-org/mezod-contracts",
    "@mezo-org/musd-contracts",
  ],
  webpack: (config) => {
    // RainbowKit's barrel re-exports every wagmi connector, including the Base
    // Account connector, whose Coinbase SDK imports the unpublished optional
    // dependency `@x402/core/client`. We never offer Base Account (see
    // PRISM_WALLETS in src/providers/PrismWeb3Provider.tsx), so stub the module
    // out instead of shipping an unused payment stack into the bundle.
    // The x402 family are the SDK's agent-payment modules; none of them is
    // published as a resolvable dependency for our install.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/svm": false,
    };
    return config;
  },
};

export default nextConfig;
