package views

// The RNAxRay logo of the web app (web/assets/rnaxray-logo*.png, copied here;
// desktop/scripts/make-icon.py draws the app icon from the same mark).

import (
	_ "embed"

	"github.com/egoist/mygo/ui"
)

var (
	//go:embed assets/rnaxray-logo.png
	logoPNG []byte
	//go:embed assets/rnaxray-logo-dark.png
	logoDarkPNG []byte

	logoLight = mustBitmap(logoPNG)
	logoDark  = mustBitmap(logoDarkPNG)
)

// logoAspect is the logo's width / height (158 x 67).
const logoAspect = 158.0 / 67.0

func mustBitmap(data []byte) *ui.Bitmap {
	b, err := ui.DecodeBitmap(data)
	if err != nil {
		panic("views: logo: " + err.Error())
	}
	return b
}

// Logo shows the RNAxRay logo height DIPs high, in the theme's variant.
func Logo(c *ui.Context, height float32) ui.Element {
	b := logoLight
	if c.Theme().Dark {
		b = logoDark
	}
	return ui.Image(c, b).Width(height * logoAspect).Height(height).Label("RNAxRay")
}
