// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { mountChrome } from './partials.js';
mountChrome('/works-with');
await import('./works-with.js');
