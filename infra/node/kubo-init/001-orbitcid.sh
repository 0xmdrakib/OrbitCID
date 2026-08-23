#!/bin/sh
set -eu

# The private fallback gateway must serve only locally retained data and must
# never become a general-purpose public gateway or fetch proxy.
ipfs config --json Gateway.NoFetch true
