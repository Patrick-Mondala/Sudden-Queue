#!/usr/bin/env bash
#
# Publishes a built release to this deployment.
#
#   sudo deploy/publish-release.sh          # the latest published release
#   sudo deploy/publish-release.sh v0.1.3   # a particular one
#
# Fetches the installer, its checksums and the manifest from the GitHub
# release, checks them, and puts them where Caddy serves them from.
#
# This exists because the manual version is six commands whose order matters
# silently. latest.json is what raises the version floor: the moment it lands,
# every older client is refused, and if the installer it names is not there yet
# they are refused from an app that cannot download the thing that would let
# them back in. So here the manifest moves last, after the installer is in
# place and has been checked, and nothing is copied into the live directory
# until all of it has been verified somewhere else.
#
# Pull rather than push, deliberately. The alternative is CI holding an SSH key
# to this box, which is a credential that can do rather more than publish a
# release, kept somewhere with a much larger attack surface than the server it
# opens.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
releases="$root/releases"

fail() { echo "publish-release: $*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is not installed"
command -v sha256sum >/dev/null || fail "sha256sum is not installed"
command -v tar >/dev/null || fail "tar is not installed"

[ -d "$releases" ] || fail "no releases directory at $releases -- is this the deployment checkout?"

# Who to fetch from, taken from the checkout rather than written here again.
remote="$(git -C "$root" config --get remote.origin.url || true)"
[ -n "$remote" ] || fail "no git remote in $root, so there is nowhere to fetch a release from"
slug="$(printf '%s' "$remote" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
[ -n "$slug" ] || fail "cannot read owner/repo out of $remote"

tag="${1:-}"
if [ -z "$tag" ]; then
  # The latest *published* release. A draft has not been looked at by a person
  # yet, and this is not the place to decide it is ready.
  tag="$(curl -fsSL "https://api.github.com/repos/$slug/releases/latest" |
    grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$tag" ] || fail "no published release found for $slug"
fi

base="https://github.com/$slug/releases/download/$tag"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

echo "Publishing $tag from $slug"

# The manifest first, but into staging -- it names the installer, and it is the
# last thing that will be allowed near the live directory.
curl -fsSL -o "$staging/latest.json" "$base/latest.json" ||
  fail "no latest.json in $tag. Is the release still a draft?"

version="$(grep -m1 '"version"' "$staging/latest.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
installer="$(grep -m1 '"url"' "$staging/latest.json" | sed -E 's#.*/([^/"]+)".*#\1#')"
[ -n "$version" ] || fail "latest.json names no version"
[ -n "$installer" ] || fail "latest.json names no installer"

# A tag and a manifest that disagree means one of them is from another release,
# and publishing either would tell clients to install something that is not
# what arrived.
[ "$version" = "${tag#v}" ] ||
  fail "$tag carries a manifest for $version. Refusing to publish a mismatch."

# Asked before the installer is fetched rather than after, so a run with
# nothing to do costs a manifest instead of three megabytes -- which is the
# difference between this being safe to put on a timer and not.
#
# The installer has to be there too. A manifest that arrived without one is
# exactly the half-finished state worth finishing rather than skipping.
#
# The version-free alias counts as part of being published, too. Without it
# here, a deployment already serving the current version could never grow one:
# every run would decide there was nothing to do, and the download page would
# point at a 404 until whenever the next release happened to come along. That
# is precisely the state this deployment was in the day the alias was added.
alias_name="$(printf '%s' "$installer" | sed -E "s/_${version//./\\.}_/_/")"

# The browser build of the client, which lands in a different directory and is
# tracked by its own marker. Asked about before the early exit below, because
# "the installer is already published" stopped being the same question as
# "this deployment is fully published" the moment there were two artifacts.
#
# Releases cut before the browser build existed simply do not have one. Those
# publish exactly as they always did rather than failing, so re-publishing an
# older tag stays possible.
webroot="$root/webapp"
# Outside the web root on purpose: everything in there is served at /app.
web_marker="$root/.webapp-published"
have_web=0
curl -fsSLI -o /dev/null "$base/webapp.tar.gz" 2>/dev/null && have_web=1

web_current=""
[ -f "$web_marker" ] && web_current="$(cat "$web_marker")"

current=""
if [ -f "$releases/latest.json" ]; then
  current="$(grep -m1 '"version"' "$releases/latest.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/' || true)"
  if [ "$current" = "$version" ] &&
     [ -f "$releases/$installer" ] &&
     { [ "$alias_name" = "$installer" ] || [ -f "$releases/$alias_name" ]; } &&
     { [ "$have_web" = 0 ] || [ "$web_current" = "$version" ]; }; then
    echo "$version is already published. Nothing to do."
    exit 0
  fi
fi
[ -z "$current" ] || [ "$current" = "$version" ] || echo "Replacing $current with $version"

curl -fsSL -o "$staging/SHA256SUMS" "$base/SHA256SUMS" || fail "no SHA256SUMS in $tag"
curl -fsSL -o "$staging/$installer" "$base/$installer" || fail "no $installer in $tag"
if [ "$have_web" = 1 ]; then
  curl -fsSL -o "$staging/webapp.tar.gz" "$base/webapp.tar.gz" ||
    fail "webapp.tar.gz is listed in $tag but could not be fetched"
fi

echo -n "Checking $installer ... "
(cd "$staging" && sha256sum -c --status SHA256SUMS) ||
  fail "checksum mismatch. The download is corrupt or the release was rebuilt; nothing has been changed."
echo "ok"

# Installer and checksums first, manifest last, each moved rather than written
# in place so nothing is ever half a file while the server is reading it.
install -m 0644 "$staging/$installer" "$releases/.$installer.incoming"
mv -f "$releases/.$installer.incoming" "$releases/$installer"
install -m 0644 "$staging/SHA256SUMS" "$releases/.SHA256SUMS.incoming"
mv -f "$releases/.SHA256SUMS.incoming" "$releases/SHA256SUMS"

# A copy under a name with no version in it, so the download page and every
# link anyone has ever pasted into Discord keep working across releases. The
# versioned file stays: it is what latest.json names, what SHA256SUMS vouches
# for, and what the server checks before it raises the floor. This is an alias
# for people, not for machines.
if [ "$alias_name" != "$installer" ]; then
  install -m 0644 "$staging/$installer" "$releases/.$alias_name.incoming"
  mv -f "$releases/.$alias_name.incoming" "$releases/$alias_name"
fi

# The browser client, before the manifest and for the same reason the
# installer goes first: this bundle reports the version it was built as, so
# from the moment the floor rises a stale one is refused by the very server
# serving it. Publishing it after latest.json would put the website behind the
# floor for as long as the gap lasted.
#
# Unpacked into the existing directory rather than swapped for it. Caddy has
# this path bind-mounted, and a mount follows the directory it was given -- so
# replacing it would leave the container serving an inode nothing writes to any
# more, which looks exactly like a publish that silently did nothing.
if [ "$have_web" = 1 ]; then
  echo -n "Installing the browser client ... "
  mkdir -p "$staging/webapp" "$webroot"
  tar -xzf "$staging/webapp.tar.gz" -C "$staging/webapp"
  [ -f "$staging/webapp/index.html" ] || fail "webapp.tar.gz contains no index.html"

  # Everything except the page, merged into place. Asset filenames carry a
  # content hash, so they cannot collide with what is already live and the
  # current page keeps working while they land.
  #
  # The trailing "/." matters: without it, cp puts assets/ inside an existing
  # assets/ instead of merging with it, and the second publish is the one that
  # breaks.
  mv "$staging/webapp/index.html" "$staging/index.html"
  cp -a "$staging/webapp/." "$webroot/"

  # The page last: it is the file that names the new assets.
  install -m 0644 "$staging/index.html" "$webroot/.index.html.incoming"
  mv -f "$webroot/.index.html.incoming" "$webroot/index.html"

  # Bundles from earlier releases, now unreferenced. Removed after the new page
  # is live rather than before, so nothing is ever missing mid-swap.
  if [ -d "$webroot/assets" ]; then
    for f in "$webroot/assets"/*; do
      [ -e "$f" ] || continue
      [ -e "$staging/webapp/assets/$(basename "$f")" ] || rm -f "$f"
    done
  fi

  printf '%s' "$version" > "$web_marker"
  echo "ok"
fi

install -m 0644 "$staging/latest.json" "$releases/.latest.json.incoming"
mv -f "$releases/.latest.json.incoming" "$releases/latest.json"

echo "Published $version. The floor rises to it within a few seconds."

# What a player's client will actually fetch, asked the way they will ask it.
hostname="$(grep -m1 '^SQ_HOSTNAME=' "$root/.env" 2>/dev/null | cut -d= -f2- || true)"
if [ -n "$hostname" ] && [ "${hostname#:}" = "$hostname" ]; then
  echo -n "Serving: "
  curl -fsS "https://$hostname/download/latest.json" | grep -m1 '"version"' ||
    echo "  could not read https://$hostname/download/latest.json -- check the caddy container"
fi
