import { render } from "preact";
import CartDrawer, { type CartDrawerProps } from "../islands/CartDrawer";

/** Render the drawer into #cart-root (its props are serialised there by Base.astro). */
export function mountCart(): void {
  const root = document.getElementById("cart-root");
  if (!root || root.hasAttribute("data-mounted")) return;
  try {
    const props = JSON.parse(root.dataset.props ?? "{}") as CartDrawerProps;
    root.setAttribute("data-mounted", "");
    render(<CartDrawer {...props} />, root);
  } catch (err) {
    console.error("cart drawer failed to mount", err);
  }
}
