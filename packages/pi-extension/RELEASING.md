# Releasing `threadroom-pi`

`threadroom-pi` is released independently from the unfinished main Threadroom product. Private questions are the usable beta feature; shared Threadroom discussions remain experimental and off by default.

## Before publishing

1. Review the package README, MIT license, packed source, and whether the GitHub repository is ready for public visitors. A public npm package exposes its tarball even while its repository is private.
2. Commit every release input. The gate covers `packages/pi-extension`, `packages/service`, `src`, and `public` because the adapter carries the generated local service archive for offline opt-in installation.
3. Use Node 24 and identify the supported installed Pi package:

   ```sh
   export THREADROOM_PI_SDK_ROOT=/absolute/path/to/@earendil-works/pi-coding-agent
   npm run pi:release:check
   ```

   This runs the Pi extension suite with the physical PTY flow, creates the real tarball, installs it offline without peer dependencies or the app, loads private questions through Pi even without the service archive, verifies offline app installation only after shared opt-in, and executes an npm publish dry run. It does not publish.
4. Confirm the personal npm account and two-factor authentication:

   ```sh
   npm whoami
   npm view threadroom-pi version dist-tags
   ```

   A first release should still report `threadroom-pi` as unavailable until publication.

## Publish the beta

The prepublish gate rejects npm's `latest` default unless the command explicitly selects `beta`; the manifest also fixes public access. Keep both flags visible during the reviewed publish:

```sh
npm publish --workspace threadroom-pi --tag beta --access public
```

Then verify the registry and install the exact release through Pi:

```sh
npm view threadroom-pi version dist-tags
pi -e npm:threadroom-pi@0.1.0-beta.0
```

Tag the verified commit as `threadroom-pi-v0.1.0-beta.0` and push that tag. Keep prerelease publication explicit with `--tag beta`; npm may also point `latest` at a registry's first published version, but the prerelease version remains the authoritative stability signal. If a beta is flawed, deprecate that immutable version and publish the next prerelease rather than silently replacing it.
