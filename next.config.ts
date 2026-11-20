import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // 左下角有我们自己的设置入口，关掉 Next 的开发指示器避免遮挡
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: path.resolve(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
