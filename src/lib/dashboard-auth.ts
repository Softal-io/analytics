import { getPrincipal } from "@/lib/access"
import { authorizeRequest } from "@/lib/access-policy"

export async function authorizeDashboard(
  request: Request
): Promise<Response | null> {
  return authorizeRequest(request, () => getPrincipal(request.headers))
}
