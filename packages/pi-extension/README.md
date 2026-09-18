# Threadroom for Pi — reserved, not implemented

This workspace will make Threadroom the ordinary asking system for Pi agents. Today it contains packaging metadata only: no executable extension, tool registration, automatic installation, or changed asking behavior.

## Boundary

The adapter will use the standalone Threadroom HTTP API, not its database, website, or server internals. Normal asks should stay cheap; deeper discussions remain optional. Threadroom owns durable questions, replies, and authored content. Pi owns its caller/session context and how a result resumes agent work. Disconnecting or canceling a wait doesn't delete the question.

The service and website continue to run without Pi. Host-SDK dependencies belong in this workspace when implementation needs them, not in the service. See the repository's [API contract](https://github.com/Scott-Meyer/threadroom/blob/main/API.md) when developing; this package's release artifact intentionally excludes the server/UI.

## Packaging now

From the repository root:

```sh
npm run pi:pack:check  # inspect the distribution, without producing an archive
npm run pi:pack        # produce threadroom-pi-0.0.0.tgz locally
```

The current artifact is an inert scaffold, not an asking extension. An explicit file allowlist keeps backend code, website files, local SQLite data, and session artifacts out. `private: true` prevents accidental npm publication; local tarball packaging still works.

## Deployment when implemented

For local development, Pi supports `pi install ./packages/pi-extension`. The repository root also declares this workspace's extension directory, so the same source can be installed from the private Git repository after release:

```sh
# Example future ref, not a tag that exists today:
pi install git:git@github.com:Scott-Meyer/threadroom@pi-v0.1.0
```

Use one installation route. Pi refs are pinned; moving to a later release means installing its new ref explicitly. Private Git installation uses the consumer's authorized GitHub SSH access. It doesn't deploy or start the Threadroom service.

The future release path is: implement and exercise the actual Pi asking boundary, version this workspace, check the packed contents, then create a signed `pi-v<VERSION>` tag and distribute that Git ref (optionally the tarball as a private GitHub release asset). No publishing/deployment workflow is enabled for the unimplemented adapter, and no release tag is created now. Registry publication or making anything public is a separate decision.
