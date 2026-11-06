import { ResponseType } from './Types'

export function checkIsLoggedIn(userId) {
  return userId !== ''
}

export function checkNameValid(name) {
  return String(name).length <= 50 && String(name).length > 0
  // check name with regex?
}

export function checkEmailValid(email) {
  return String(email).match(/^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/)
}

export function statusToColor(status) {
  switch (status) {
    case ResponseType.A:
      return 'green'
    case ResponseType.R:
      return 'red'
    default:
      return 'black'
  }
}

export function validatePassword(password) {
  // At least 8 characters long
  // Contains at least one uppercase letter, one lowercase letter, one digit, and one special character
  const regex =
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~])[A-Za-z\d!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~]{8,}$/
  return regex.test(password)
}
