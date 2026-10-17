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

// The RNAxRay accent of the web app (web/styles.css --teal, --teal-deep,
// --primary-hover, --primary-foreground and, for text, --primary-ink),
// replacing MyGo's blue and the system's accent color.
var (
	brandTeal      = ui.Hex("#00a09d")
	brandTealDeep  = ui.Hex("#007b78")
	brandNavy      = ui.Hex("#10263d")
	brandInkLight  = ui.Hex("#007672")
	brandInkDark   = ui.Hex("#35c3c0")
	brandHoverLite = ui.Hex("#00b0ac")
)

// The navy-tinted neutrals of the web app, light and dark (web/styles.css
// --surface, --canvas, --surface-subtle, --line, --ink, --muted and the
// status colors). Background is the web's card surface (cards, sidebar,
// top bar), Surface its subtle surface (controls, insets) and brandCanvas
// the page behind the cards.
var (
	brandLight = brandNeutrals{
		background: ui.Hex("#ffffff"), canvas: ui.Hex("#f3f7f8"), soft: ui.Hex("#e3f7f6"),
		surface: ui.Hex("#f3f7f8"), surfaceHover: ui.Hex("#e9f1f3"), surfacePressed: ui.Hex("#dce7ec"),
		border: ui.Hex("#dce7ec"), text: ui.Hex("#132c47"), textMuted: ui.Hex("#5b6c80"),
		danger: ui.Hex("#b42318"), warning: ui.Hex("#9c5e12"), success: ui.Hex("#007b78"),
	}
	brandDark = brandNeutrals{
		background: ui.Hex("#132c47"), canvas: ui.Hex("#0c1a29"), soft: ui.Hex("#123f4b"),
		surface: ui.Hex("#183650"), surfaceHover: ui.Hex("#21405e"), surfacePressed: ui.Hex("#2e4b66"),
		border: ui.Hex("#2e4b66"), text: ui.Hex("#ecf1f8"), textMuted: ui.Hex("#9eb1c3"),
		danger: ui.Hex("#f29c96"), warning: ui.Hex("#f5b867"), success: ui.Hex("#43d1b0"),
	}
)

type brandNeutrals struct {
	background, canvas, soft              ui.Color
	surface, surfaceHover, surfacePressed ui.Color
	border, text, textMuted               ui.Color
	danger, warning, success              ui.Color
}

func brandOf(t *ui.Theme) *brandNeutrals {
	if t.Dark {
		return &brandDark
	}
	return &brandLight
}

// applyBrandTheme gives the frame's theme (light or dark as the system is,
// with its contrast and text size preferences) the RNAxRay colors.
func applyBrandTheme(c *ui.Context) {
	t := *c.Theme()
	n := brandOf(&t)
	t.Background, t.Surface, t.SurfaceHover, t.SurfacePressed = n.background, n.surface, n.surfaceHover, n.surfacePressed
	t.Border, t.Text, t.TextMuted = n.border, n.text, n.textMuted
	t.Danger, t.Warning, t.Success = n.danger, n.warning, n.success
	t.Accent, t.AccentPressed, t.AccentText = brandTeal, brandTealDeep, brandNavy
	if t.Dark {
		t.AccentHover = brandInkDark
		t.Selection, t.Focus = brandTeal.Alpha(0.4), brandInkDark.Alpha(0.6)
	} else {
		t.AccentHover = brandHoverLite
		t.Selection, t.Focus = brandTeal.Alpha(0.25), brandTeal.Alpha(0.55)
	}
	// What MyGo's own theme does for Increase Contrast, on these colors.
	if c.Preferences().HighContrast {
		t.Border = t.Border.Mix(t.Text, 0.45)
		t.TextMuted = t.TextMuted.Mix(t.Text, 0.4)
		t.Focus.A = 255
	}
	c.SetTheme(&t)
}

// brandCanvas is the page behind the cards (web --canvas).
func brandCanvas(t *ui.Theme) ui.Color { return brandOf(t).canvas }

// brandSoft is the light teal of a chosen item (web --primary-soft).
func brandSoft(t *ui.Theme) ui.Color { return brandOf(t).soft }

// brandInk is the accent for text, which plain teal is too light for on a
// light background.
func brandInk(t *ui.Theme) ui.Color {
	if t.Dark {
		return brandInkDark
	}
	return brandInkLight
}

// brandLink is ui.Link in the accent for text.
func brandLink(c *ui.Context, label string) ui.Element {
	return ui.Link(c, label, "").TextColor(brandInk(c.Theme()))
}

// Logo shows the RNAxRay logo height DIPs high, in the theme's variant.
func Logo(c *ui.Context, height float32) ui.Element {
	b := logoLight
	if c.Theme().Dark {
		b = logoDark
	}
	return ui.Image(c, b).Width(height * logoAspect).Height(height).Label("RNAxRay")
}
