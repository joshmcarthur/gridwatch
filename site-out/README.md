# site-out

This directory is the built site. The `site-build` service writes into `releases/a` or `releases/b`, and points the `current` symlink at the live slot. The `site` service serves `current` with nginx. Git ignores everything here except this file.
