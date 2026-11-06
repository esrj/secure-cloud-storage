/**
 * This file handles input validations
 */
export const Validators = {
  name(input) {
    const pattern = /^[\p{L}\p{M}\s'-]{1,50}$/u
    if (!input) return { valid: false, message: 'Name is required.' }
    if (!pattern.test(input)) {
      return {
        valid: false,
        message:
          'Name can contain letters (any language), spaces, apostrophes, and hyphens, up to 50 characters.'
      }
    }
    return { valid: true }
  },

  email(input) {
    const pattern = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}$/u
    if (!input) return { valid: false, message: 'Email is required.' }
    if (!pattern.test(input)) {
      return {
        valid: false,
        message: 'Please enter a valid email address.'
      }
    }
    return { valid: true }
  },

  fileDescription(input) {
    const pattern = /^(?!.*[<>={}])[\p{L}\p{N}\p{P}\p{Zs}]{1,500}$/u
    // if (!input) return { valid: false, message: 'Description is required.' }
    if (!input) return { valid: true }
    if (!pattern.test(input)) {
      return {
        valid: false,
        message:
          'Description can contain letters, numbers, punctuation, and spaces (no < > { } allowed), up to 500 characters.'
      }
    }
    return { valid: true }
  },

  message(input) {
    const pattern = /^(?!.*[<>={}])[\p{L}\p{N}\p{P}\p{S}\p{Zs}\p{Emoji}]{1,500}$/u
    // if (!input) return { valid: false, message: 'Message cannot be empty.' }
    if (!input) return { valid: true }
    if (!pattern.test(input)) {
      return {
        valid: false,
        message:
          'Message contains invalid characters (no < > { } allowed). Emoji and multilingual text are allowed. Max 500 characters.'
      }
    }
    return { valid: true }
  },

  tags(input) {
    // empty string is allowed (optional)
    if (!input) return { valid: true }

    const pattern = /^([\p{L}\p{N}_-]+(\s+[\p{L}\p{N}_-]+)*)?$/u
    if (!pattern.test(input)) {
      return {
        valid: false,
        message:
          'Tags must be words separated by spaces, using letters, numbers, hyphens, or underscores.'
      }
    }
    return { valid: true }
  },

  search(input) {
    const pattern = /^[\p{L}\p{N}\p{P}\p{Zs}]{0,200}$/u
    if (!pattern.test(input)) {
      return {
        valid: false,
        message:
          'Search input can include letters, numbers, punctuation, and spaces, up to 200 characters.'
      }
    }
    return { valid: true }
  },

  verificationCode(input) {
    const pattern = /^[A-Za-z0-9]{6}$/
    if (!pattern.test(input)) {
      return {
        valid: false,
        message: 'Verification code must be exactly 6 letters or numbers.'
      }
    }
    return { valid: true }
  },

  password(input) {
    if (!input) {
      return { valid: false, message: 'Password is required.' }
    }

    if (input.length < 8 || input.length > 32) {
      return {
        valid: false,
        message: 'Password must be between 8 and 32 characters long.'
      }
    }

    const upper = /[A-Z]/
    const lower = /[a-z]/
    const digit = /[0-9]/
    const special = /[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/;`~]/

    if (!upper.test(input)) {
      return {
        valid: false,
        message: 'Password must contain at least one uppercase letter.'
      }
    }

    if (!lower.test(input)) {
      return {
        valid: false,
        message: 'Password must contain at least one lowercase letter.'
      }
    }

    if (!digit.test(input)) {
      return {
        valid: false,
        message: 'Password must contain at least one number.'
      }
    }

    if (!special.test(input)) {
      return {
        valid: false,
        message: 'Password must contain at least one special character.'
      }
    }

    return { valid: true }
  },

  uuidv4(input) {
    const pattern =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
    if (!pattern.test(input)) {
      return {
        valid: false,
        message: 'Invalid UUIDv4 format.'
      }
    }
    return { valid: true }
  },

  folderName(input) {
    const pattern = /^(?!.*[\\/:*?"<>|])[\p{L}\p{N}\p{M}\s_-]{1,255}$/u
    if (!input) {
      return { valid: false, message: 'Folder name is required.' }
    }
    if (!pattern.test(input)) {
      return {
        valid: false,
        message: String.raw`Folder name may include letters, numbers, spaces, hyphens, and underscores, but cannot contain \ / : * ? " < > |.`
      }
    }
    return { valid: true }
  }
}
