# Stage 2 visual evidence manifest

Status: **PASS — 28/28 recorded-positive module charts rendered**

The renderer consumed locked golden results and recorded M15 candles. It did not import, execute, or recompute any detector or indicator.

Contact sheet: `docs/stage2-gate/contact-sheet.png`  
SHA-256: `202b20a2a2f1011917b884419478902531e9d3cf2a215ecd2689f6ee3d74e4bc`

| Module | Source | Event | Result | Golden SHA-256 | Image SHA-256 |
|---|---|---|---|---|---|
| M01 Bullish FVG Fill | trending · BTCUSD.m · M15 | `2026-06-29T16:00:00+00:00` | BUY · 85 | `3922506033fccf45f8ea10390dc17f1ba41cfff75b47fcce14027b65a6e268c9` | `1e460e09a513ad4cbd71ba72e211519c9c20d697e58d6760c1a2245c150ef67b` |
| M02 Bearish FVG Fill | trending · BTCUSD.m · M15 | `2026-06-29T14:30:00+00:00` | SELL · 95 | `1cf77337e44c20bf80b9a146411eed5b014dc3490f1e2e45e54b72fd1ef32c01` | `6b263309d29a420e8dbf930d719762245ad033fd0c090df193ab1e451f789439` |
| M03 Bullish Order Block | trending · BTCUSD.m · M15 | `2026-07-01T06:30:00+00:00` | BUY · 95 | `98fa43595e4546478490ca7e7e50abdb466255ce72a6a8d0e1c5c216caf5a886` | `8366667dc9e88b7a1af013a6b0070a66e3b49f2c77b7a6dfec042821c4fb8db5` |
| M04 Bearish Order Block | trending · BTCUSD.m · M15 | `2026-06-30T11:45:00+00:00` | SELL · 95 | `3ac51d9b6f92db7533c5f7fb61ef8236e91dc5745bf5c0ea216dcd233e7d5a84` | `168c80108a8468e6e26c54012f648e8f2201a82ef6c22b8b16a2c42acaacf728` |
| M05 Sell-Side Liquidity Sweep | trending · BTCUSD.m · M15 | `2026-07-03T01:00:00+00:00` | BUY · 85 | `bad11c1fd79f5cf2cd181c46000c2bc52bef866363e47b0e9aacc9571a4b57c8` | `6217eb0d3ae6cb1e48ae6a1d8243cdbef8cc670d192ae6dd08417ecad9cdae98` |
| M06 Buy-Side Liquidity Sweep | trending · BTCUSD.m · M15 | `2026-07-01T01:45:00+00:00` | SELL · 85 | `6e4bd03fc5586c5bd5f3ebb9770523142acb140ce4d0dcb2ca121b83edb258a1` | `b91facafcb3a0a8b6858a72de0c30dd76f0b903d01efe8127a480cf39bc04f97` |
| M07 Change of Character (CHoCH) | trending · BTCUSD.m · M15 | `2026-06-30T07:15:00+00:00` | SELL · 65 | `8c7adcaad65e764413d57ed0516217faa28f753bec4b1f6c224afbe838051111` | `35b134ab6327bd73716c6b2ddaeac7ac5c90c836a025cf6a676e35bf440605dd` |
| M08 Break of Structure (BOS) | trending · BTCUSD.m · M15 | `2026-06-30T05:15:00+00:00` | SELL · 65 | `45faa7b17a521316e8b7b3371792144aad96713b894bded4aff8a8fdb7aa33cb` | `c885623817b47acfa6369b1d10a7981ead493d7da77f1bab58a58fda4552314c` |
| M09 Breaker Block Mitigation | trending · BTCUSD.m · M15 | `2026-07-01T13:30:00+00:00` | BUY · 85 | `cdca8bf05d5fc07f912727c3141f1eeaab84ab1960aa3118efbba0bbc1ebdfbd` | `0558f5a11891076192b5f8646fb09c436b9a925313bef406d48c345ed5e230ef` |
| M10 Liquidity Void Re-alignment | ranging · GBPUSD.m · M15 | `2026-06-09T23:00:00+00:00` | BUY · 95 | `007fac1b3ccb7db64a049828956e4d627979a1dc5ec5a0a63316d4fd258fb361` | `e946c3a0ab5865cff9da1e12413e5bf93ef44f5008359f341024686f7977c4df` |
| M11 Quasimodo Level Reversal | trending · BTCUSD.m · M15 | `2026-06-30T00:15:00+00:00` | SELL · 85 | `8a08429fd6b05798f497abb96626611e5ab03d082ea4d41eb06768c2a4a9e63a` | `87f1e4a6e54a8ac08ca8419532e97c566908fa284ab035d990cd37cc10c90be2` |
| M12 Support/Resistance Flip | trending · BTCUSD.m · M15 | `2026-07-01T01:15:00+00:00` | SELL · 85 | `d59865b8a3ee63b8ce9a500d00c34a74630058dd67b5af34bc83a97a534035c3` | `22f992fd1b03bf8bdac6d6bcecf7a6d3fe6690c03302309fb7674635385764ca` |
| M13 Supply/Demand Zone Retest | trending · BTCUSD.m · M15 | `2026-06-30T14:00:00+00:00` | SELL · 95 | `c29e45d960af36ad01d3a2c145a74b3ea24cac2904a657c59d8c84f195e7c224` | `cbc63374c5d54ec3bd8d43e9e7149ab482ef6aef2e458c928eeaac8b2313f55f` |
| M14 Double Bottom/Top Validation | trending · BTCUSD.m · M15 | `2026-06-30T03:15:00+00:00` | SELL · 75 | `0e20f3f709fef1c28a85ad39c482bd5f6fa55416314bffa874c7a3fbde59e451` | `349ecedbc778843832826ac936082e976b2f3ddb7210b1bc379c289c68df5985` |
| M15 Pinbar/Hammer Exhaustion | trending · BTCUSD.m · M15 | `2026-07-01T23:15:00+00:00` | SELL · 75 | `5398f91a32850a0dcc6d88dfa40c867bc9d268ab3b494233c8e6f1102b005e87` | `ff02a33a3446e9e933168e54d3c5c45c4e02b16443f4afcd0952761a15080619` |
| M16 Engulfing Cluster | trending · BTCUSD.m · M15 | `2026-06-29T12:00:00+00:00` | BUY · 95 | `54e5cf21d2c778e78e3c73042382fa7a93575944b97a8f57ed3b6625aea75d27` | `bcb57e131ce5227e2575758fed2aac0e70c0884f162950c9a133338f3f4af7fd` |
| M17 Triple EMA Alignment | trending · BTCUSD.m · M15 | `2026-07-01T08:15:00+00:00` | SELL · 85 | `50ad0ef3e4364ea3ad4eb038e6fd42948043e12cd5159bcb5b2f1b4d2a711d68` | `b9c1cf56f1cb9a85ed4121ae171a80de333b7ab5fb6f2d24d195341cd672483f` |
| M18 EMA Dynamic Pullback | trending · BTCUSD.m · M15 | `2026-07-01T13:00:00+00:00` | SELL · 75 | `6bd5bdf8f53bc8b6f9d778a609052f632b96d9b4f2c00ff14412fb60930bfe05` | `895bfe46b9d9b1f7eb38fd344dd6e987972a410929b6b9dcf22ea4c35c56931f` |
| M19 MACD Zero-Line Crossover | trending · BTCUSD.m · M15 | `2026-06-29T13:30:00+00:00` | SELL · 85 | `495a09b4881b76ef4bbbedca9b74a6f5138431d8e153d7261266c787348caa58` | `96f7e9be37f77c1bee82f832e626192f276590bb369252f1678710896db8bc3b` |
| M20 RSI Divergence (Regular) | trending · BTCUSD.m · M15 | `2026-06-30T06:00:00+00:00` | BUY · 65 | `be12c0b8ca79e38be63a776a4b77298f31396244a7b1df1f59f2296a0d4faf9b` | `42cb61feb79a7507ced866602ba43bc5761ee3ff38d7b67bda39ff6e0d65826e` |
| M21 ADX Trend Acceleration | trending · BTCUSD.m · M15 | `2026-06-30T03:45:00+00:00` | SELL · 75 | `8bdc82cfa8f733a097b7147799ce08678190ab90ec76e20543a8974e936da1f4` | `b7eafaa88d995a1823b2f35c7ded41c185d39bc13a3562e03fe6d54e899ed3ce` |
| M22 Supertrend Directional Flip | trending · BTCUSD.m · M15 | `2026-06-29T12:00:00+00:00` | BUY · 95 | `62dc1bc1bc7e225752f3dd338f7057b94bfa4f2a962c588c042f03b7cc56b843` | `35db371cec141cd363530edabc14c3c44561b7e9fc883b8c02616926b299a31e` |
| M23 Bollinger Squeeze Breakout | trending · BTCUSD.m · M15 | `2026-06-30T12:00:00+00:00` | SELL · 85 | `8d14fe2895028b0ffbbeb52b1a4a2d731d3c7623a5e36ca7b84b5eb3f1e7e46f` | `b4081a69f17ec8b62a473115dc95bd5e59dd054f31d0108cc1c118df7fd16ad7` |
| M24 Bollinger Outer Reversion | trending · BTCUSD.m · M15 | `2026-06-29T12:15:00+00:00` | SELL · 75 | `152d8eea1320e7ff7519b39185707dcaf6839c70c05a64915e5a1a4e6268b326` | `9faf628c6ec508f2be8d90c07263dc5183a4b0c2ebbaed90183fcb8e6e4231d7` |
| M25 VWAP Deviation Touch | trending · BTCUSD.m · M15 | `2026-06-29T10:00:00+00:00` | SELL · 75 | `4dd0b2aa60c89b69ed8433d741365c18ddb045850ec29d1bf5d09b15b937c614` | `34b97f2d66dc890523882a45fbdf74beba9bb587dd0ffbd89f390d525967e275` |
| M26 Keltner Channel Reversal | trending · BTCUSD.m · M15 | `2026-06-29T17:30:00+00:00` | SELL · 75 | `24551f5459e1e519e5f38c0cad1509f1f78cdb56c83e30804e3f0744bc048f7c` | `bc5a882bec23c3f7dcb900b5847b177cb39d94b22cc7c98b890c528ed9d4a8e1` |
| M27 ATR Volatility Expansion | trending · BTCUSD.m · M15 | `2026-07-01T15:15:00+00:00` | BUY · 75 | `a277ef06f825592182a8a748fb5423b4a498377d0fce43e27577e9675489becb` | `28c1fd12abebdaefa41876d11fca6593206deaf70aed5968d205021a203148c5` |
| M28 Session Open Range Breakout | trending · BTCUSD.m · M15 | `2026-06-30T08:00:00+00:00` | SELL · 75 | `61d6e293ffa1613170d6dbc6eedcf5d3f8a0492292227baf2b632c6cede7919c` | `9426729af10a7804a93f23386020fe3e076f67589d9232353dd3272c24675477` |

Each chart shows raw recorded candles, a dashed event-bar marker, and only the typed coordinates already present in `evidence.geometry`.
