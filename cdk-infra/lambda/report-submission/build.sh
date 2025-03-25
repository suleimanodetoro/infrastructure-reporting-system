#!/bin/bash
npm install
npx tsc
cp package.json dist/
cd dist
npm install --production