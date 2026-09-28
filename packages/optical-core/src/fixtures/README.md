# Camera regression fixture

`iphone-9790.gray.gz` is the camera-only crop of the user-provided
`IMG_9790.PNG`: x=48, y=302, width=1224, height=2176. Browser controls are
excluded. It contains a public optical handshake offer, not file contents or
private keys. Pixels are unscaled 8-bit Rec.709 luminance, row-major, gzip
compressed. No thresholding or geometric correction is baked into the fixture.

The 320×180 binary grid is rotated 90° and has mild lens distortion. Its
expected frame ID is 391, payload length 73, and payload CRC32 1439208518.
The test acquires the image in all four orientations and exercises cached
calibration and rejection of an incorrect payload CRC.

`iphone-9791.gray.gz` is the second user camera screenshot after the UI had
automatically zoomed to 1.6×. The camera-only crop is x=45, y=565,
width=1230, height=2190. It still contains all four finder corners. The
expected frame ID is 3910 with the same 73-byte offer and payload CRC32.
