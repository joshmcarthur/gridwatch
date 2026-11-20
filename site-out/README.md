# site-out

This directory is the built site. The `site-build` service writes one directory for each run under `releases/`, and points the `current` symlink at the newest one. The `site` service serves `current` with nginx. Git ignores everything here except this file.
