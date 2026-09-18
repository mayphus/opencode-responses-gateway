# Preserved Python proxy

`legacy/opencode-go-proxy/` contains the former `mayphus/opencode-go-proxy` fork and its Git history. The root TypeScript gateway remains the supported default here. The Python source is a preserved alternative implementation; it is not bundled into the gateway release.

Upstream remains [zhengsanniu/opencode-go-proxy](https://github.com/zhengsanniu/opencode-go-proxy). Preserve its MIT license and attribution. This repository consolidation does not modify upstream, existing installations or the user's provider configuration.

The imported fork tip is `51c9eba4cefaf402eaad5f838a88ecb51cfe3bbe`. At consolidation it was two commits ahead of upstream: retrieving individual models and endpoint-routed Go/Zen support. Both commits and all original tests remain in the imported history. Do not treat the TypeScript gateway as having these Python features unless they are separately ported and tested.

The TypeScript gateway provides its existing secure credential-store setup and native packaging. The preserved Python variant provides its original endpoint routing and Python distribution. Run its commands/tests from its own directory when maintaining that variant. No automatic migration between installations is performed.
