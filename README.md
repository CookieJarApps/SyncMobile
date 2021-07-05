# SyncMobile for xBrowserSync

xBrowserSync Firefox add-on modified to remove browser bookmark editing so it works when installed in GeckoView-based mobile browsers. This add-on does not sync browser bookmarks and only allows you to access bookmarks synced with xBrowserSync from other browsers. This add-on is not affiliated with xBrowserSync in any way, but is based on the code of their desktop add-on and Android app.

## Prerequisites

- NPM. It’s bundled with [Node.js](https://nodejs.org/) so [download and install it](https://nodejs.org/en/download/) for your platform.

## Installation

CD into the source directory and install the package and dependencies using NPM:

    $ npm install

## Building

Run a debug build for the given platform:

    $ npm run build:[platform]

or

    $ npm run watch:[platform]

Replace [platform] with the name of the platform to build. The app code will be output to the 'build/[platform]' folder. Available platforms:

- firefox-mobile


## Packaging

Run a release build and then package for the given platform:

    $ npm run package:[platform]

Replace [platform] with the name of the platform to build. The package will be output to the 'dist' folder.
