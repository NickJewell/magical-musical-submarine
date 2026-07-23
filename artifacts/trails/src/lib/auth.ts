export function getUserId(): number | null {
  const id = localStorage.getItem('trailsUserId');
  return id ? parseInt(id, 10) : null;
}

export function getUserName(): string | null {
  return localStorage.getItem('trailsUserName');
}

export function setUserId(id: number, name: string) {
  localStorage.setItem('trailsUserId', id.toString());
  localStorage.setItem('trailsUserName', name);
}

export function clearUser() {
  localStorage.removeItem('trailsUserId');
  localStorage.removeItem('trailsUserName');
}
